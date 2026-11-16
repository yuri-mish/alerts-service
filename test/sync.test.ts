// Інтеграційні тести на справжньому Postgres в окремій схемі (створюється і видаляється).
// Запуск:  DATABASE_URL=... node --test test/*.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createPool, type Db } from '../src/core/db.ts';
import { migrate } from '../src/migrate.ts';
import { startSync } from '../src/sync/sync.ts';
import { createServer } from '../src/http/server.ts';
import { config } from '../src/core/config.ts';
import { createFailureTracker, createRateLimiter } from '../src/keys/api-keys.ts';
import { registerWebhook, type InlineButton, type Telegram, type TelegramApi } from '../src/notify/telegram.ts';
import { parseHistory, type ApiAlert } from '../src/sync/alerts-api.ts';
import { createMonitor } from '../src/notify/monitor.ts';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for tests');
const schema = `alerts_test_${process.pid}`;
let db: Db;

before(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  db = createPool(url, schema);
  await migrate(db);
});

after(async () => {
  await db.end();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

const A = (p: Partial<ApiAlert> & { id: number }): ApiAlert => ({
  locationUid: 31, locationTitle: 'м. Київ', locationType: 'city',
  alertType: 'air_raid', level: 'yellow', startedAt: new Date(), finishedAt: null, updatedAt: null, ...p,
});
const D = (s: string) => new Date(s);

/** Фейковий API: відповідь для кожного регіону задається в `responses` */
let responses: Record<number, ApiAlert[]> = {};
const fetcher = async (uid: number) => responses[uid] ?? [];

const sync = async (now?: Date) => {
  const { done } = await startSync(db, fetcher, 'test', { pauseMs: 0, now: now ? () => now : undefined });
  const r = await done;
  assert.equal(r.status, 'ok', JSON.stringify(r));
  return r;
};

const periods = async (id: number) =>
  (await db.query(
    `select level, to_char(month, 'YYYY-MM') as month, to_char(day, 'YYYY-MM-DD') as day, duration_min,
            to_char(started_at at time zone $2::text, 'YYYY-MM-DD HH24:MI') as s,
            to_char(finished_at at time zone $2::text, 'YYYY-MM-DD HH24:MI') as f
       from alert_periods where alert_id = $1 order by day`, [id, config.timeZone])).rows;

/** Фейковий Telegram: запам'ятовує надіслані/змінені повідомлення і відповіді на кнопки */
const ADMIN_CHAT = 4242;
const fakeTelegram = () => {
  const sent: { text: string; buttons?: InlineButton[][]; messageId: number }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  const answers: string[] = [];
  let failing = false;
  let nextMessageId = 100;
  const api: TelegramApi = {
    sendMessage: async (_chatId, text, buttons) => {
      if (failing) throw new Error('Telegram 500: test');
      const messageId = nextMessageId++;
      sent.push({ text, buttons, messageId });
      return messageId;
    },
    editMessage: async (_chatId, messageId, text) => { edits.push({ messageId, text }); },
    answerCallback: async (_id, text) => { answers.push(text); },
    setWebhook: async () => {},
  };
  const telegram: Telegram = { api, chatId: String(ADMIN_CHAT), webhookSecret: 'test-webhook-secret' };
  return { telegram, sent, edits, answers, fail: (value: boolean) => { failing = value; } };
};

test('parseHistory: location_uid рядком, alert_level, null кінець', () => {
  const r = parseHistory({ alerts: [
    { id: 5, location_uid: '94', location_title: 'Бучанська громада', location_type: 'hromada',
      location_oblast_uid: 14, alert_type: 'air_raid', alert_level: 'red',
      started_at: '2026-11-01T10:00:00.000Z', finished_at: null, updated_at: '2026-11-01T10:05:00.000Z' },
    { id: 'bad' },
  ] });
  assert.equal(r.length, 1);
  assert.equal(r[0].locationUid, 94);
  assert.equal(r[0].level, 'red');
  assert.equal(r[0].finishedAt, null);
});

test('тривога на межі місяців розрізається на дві частини (київський час)', async () => {
  // 31.10 23:40 -> 01.11 00:30 за Києвом (UTC+2 після 25.10)
  responses = { 31: [A({ id: 1, startedAt: D('2026-10-31T21:40:00Z'), finishedAt: D('2026-10-31T22:30:00Z') })] };
  await sync(D('2026-11-02T00:00:00Z'));
  assert.deepEqual(await periods(1), [
    { level: 'yellow', month: '2026-10', day: '2026-10-31', duration_min: 20, s: '2026-10-31 23:40', f: '2026-11-01 00:00' },
    { level: 'yellow', month: '2026-11', day: '2026-11-01', duration_min: 30, s: '2026-11-01 00:00', f: '2026-11-01 00:30' },
  ]);
});

test('тривога через опівніч розрізається по київських добах', async () => {
  // 12.11 21:00 -> 13.11 02:00 за Києвом (UTC+2)
  responses = { 31: [A({ id: 12, startedAt: D('2026-11-12T19:00:00Z'), finishedAt: D('2026-11-13T00:00:00Z') })] };
  await sync(D('2026-11-14T00:00:00Z'));
  assert.deepEqual(await periods(12), [
    { level: 'yellow', month: '2026-11', day: '2026-11-12', duration_min: 180, s: '2026-11-12 21:00', f: '2026-11-13 00:00' },
    { level: 'yellow', month: '2026-11', day: '2026-11-13', duration_min: 120, s: '2026-11-13 00:00', f: '2026-11-13 02:00' },
  ]);
});

test('рівень: лишається останній відомий, зміни рівня не розділяють тривогу', async () => {
  responses = { 31: [A({ id: 2, level: 'yellow', startedAt: D('2026-11-05T10:00:00Z') })] };
  await sync(D('2026-11-05T10:10:00Z'));
  let p = await periods(2);
  assert.equal(p.length, 1);
  assert.equal(p[0].level, 'yellow');
  assert.equal(p[0].f, null); // ще триває
  assert.equal(p[0].duration_min, null);

  responses = { 31: [A({ id: 2, level: 'red', startedAt: D('2026-11-05T10:00:00Z'),
    updatedAt: D('2026-11-05T10:20:00Z'), finishedAt: D('2026-11-05T10:50:00Z') })] };
  const r = await sync(D('2026-11-05T11:00:00Z'));
  assert.equal(r.regions.find((x) => x.region === 31)?.updated, 1);
  p = await periods(2);
  assert.deepEqual(p.map((x) => [x.level, x.duration_min]), [['red', 50]]); // один відрізок, останній рівень

  // повторний прогін з тими ж даними нічого не змінює
  const again = await sync(D('2026-11-05T12:00:00Z'));
  assert.equal(again.regions.find((x) => x.region === 31)?.updated, 0);
  assert.equal((await periods(2)).length, 1);
});

test('зависла понад 3 доби тривога закривається як 30 хв, справжній кінець з API її замінює', async () => {
  responses = { 31: [A({ id: 3, startedAt: D('2026-11-06T08:00:00Z') })] };
  await sync(D('2026-11-09T07:00:00Z')); // 71 год без кінця - ще не чіпаємо
  let a = (await db.query('select closed_by, finished_at from alerts where id = 3')).rows[0];
  assert.equal(a.finished_at, null);
  assert.equal(a.closed_by, null);

  await sync(D('2026-11-09T09:00:00Z')); // 73 год
  a = (await db.query('select closed_by from alerts where id = 3')).rows[0];
  assert.equal(a.closed_by, 'stale_30min');
  assert.deepEqual((await periods(3)).map((x) => x.duration_min), [30]);

  // API досі без кінця - лишається наше закриття
  await sync(D('2026-11-09T10:00:00Z'));
  assert.deepEqual((await periods(3)).map((x) => x.duration_min), [30]);

  responses = { 31: [A({ id: 3, startedAt: D('2026-11-06T08:00:00Z'), finishedAt: D('2026-11-06T08:45:00Z') })] };
  await sync(D('2026-11-09T11:00:00Z'));
  a = (await db.query('select closed_by from alerts where id = 3')).rows[0];
  assert.equal(a.closed_by, 'api');
  assert.deepEqual((await periods(3)).map((x) => x.duration_min), [45]);
});

test('пакетний запис: дубль id у відповіді не ламає прогін, незмінена тривога лише оновлює last_seen_at', async () => {
  const same = A({ id: 20, startedAt: D('2026-11-09T10:00:00Z'), finishedAt: D('2026-11-09T10:30:00Z') });
  responses = { 31: [same, same, A({ id: 21, startedAt: D('2026-11-09T11:00:00Z'), finishedAt: D('2026-11-09T11:10:00Z') })] };
  const first = (await sync(D('2026-11-09T12:00:00Z'))).regions.find((x) => x.region === 31);
  assert.equal(first?.fetched, 3);
  assert.equal(first?.inserted, 2); // 20 і 21; дубль не вставляється вдруге
  assert.deepEqual((await periods(20)).map((x) => x.duration_min), [30]);

  const second = (await sync(D('2026-11-09T13:00:00Z'))).regions.find((x) => x.region === 31);
  assert.equal(second?.inserted, 0);
  assert.equal(second?.updated, 0);
  const seen = (await db.query('select last_seen_at from alerts where id = any($1)', [[20, 21]])).rows;
  assert.deepEqual(seen.map((x) => x.last_seen_at.toISOString()), ['2026-11-09T13:00:00.000Z', '2026-11-09T13:00:00.000Z']);
});

test('у звіти йдуть лише air_raid: артобстріл зберігається в alerts, але відрізків не має', async () => {
  responses = { 31: [
    // жовтень - щоб не заважати іншим тестам, що рахують листопад
    A({ id: 40, alertType: 'air_raid', startedAt: D('2026-10-20T10:00:00Z'), finishedAt: D('2026-10-20T10:30:00Z') }),
    A({ id: 41, alertType: 'artillery_shelling', startedAt: D('2026-10-20T10:00:00Z'), finishedAt: D('2026-10-20T11:00:00Z') }),
  ] };
  await sync(D('2026-10-20T12:00:00Z'));
  const stored = (await db.query('select id, alert_type from alerts where id = any($1) order by id', [[40, 41]])).rows;
  assert.deepEqual(stored, [{ id: 40, alert_type: 'air_raid' }, { id: 41, alert_type: 'artillery_shelling' }]);
  assert.deepEqual((await periods(40)).map((x) => x.duration_min), [30]);
  assert.deepEqual(await periods(41), []);
});

test('підрегіони: location_uid зберігається, регіон запиту - окремо', async () => {
  responses = { 14: [A({ id: 4, locationUid: 94, locationTitle: 'Бучанська громада', locationType: 'hromada',
    level: 'red', startedAt: D('2026-11-08T10:00:00Z'), finishedAt: D('2026-11-08T10:30:00Z') })] };
  await sync(D('2026-11-08T12:00:00Z'));
  const r = (await db.query('select region_uid, location_uid, level from alert_periods where alert_id = 4')).rows;
  assert.deepEqual(r, [{ region_uid: 14, location_uid: 94, level: 'red' }]);
});

test('HTTP: ключ, /summary з об\'єднанням перекриттів, /periods csv', async () => {
  responses = { 31: [
    A({ id: 10, level: 'red', startedAt: D('2026-11-10T10:00:00Z'), finishedAt: D('2026-11-10T11:00:00Z') }),
    A({ id: 11, level: 'red', startedAt: D('2026-11-10T10:30:00Z'), finishedAt: D('2026-11-10T11:30:00Z') }),
  ] };
  await sync(D('2026-11-11T00:00:00Z'));

  const server = createServer({ db, fetcher, adminKey: 'k', rateLimitPerMin: 1000, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/summary?month=2026-11`)).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);

    const h = { 'X-Api-Key': 'k' };
    const sum = await (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: h })).json() as
      { level: string; alerts: number; hours: number }[];
    const red = sum.find((x) => x.level === 'red');
    assert.ok(red, JSON.stringify(sum));
    // 10:00-11:00 і 10:30-11:30 перекриваються -> 1.5 год, плюс червона тривога з тесту рівня (50 хв)
    assert.equal(red.hours, 2.33);
    assert.ok(sum.find((x) => x.level === 'all'));

    const res = await fetch(`${base}/periods?month=2026-11&region=31&level=red&format=csv`, { headers: h });
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM для Excel
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(text.startsWith('region_uid;location_uid;location_title'), text.slice(0, 80));
    assert.equal(text.trim().split('\r\n').length, 1 + 3);

    assert.equal((await fetch(`${base}/periods?month=2026-13`, { headers: h })).status, 400);

    // вигрузка для 1С
    const ex = await (await fetch(`${base}/1c/alerts?month=2026-11&region=31`, { headers: h })).json() as
      Record<string, unknown>[];
    const d10 = ex.filter((x) => x['ДеньМесяца'] === 10);
    assert.deepEqual(d10.map((x) => x['НомерТревоги']), [1, 2]);
    assert.deepEqual(d10[0], { 'ПериодМесяц': '2026-11-01T00:00:00', 'ДеньМесяца': 10, 'КодТеритории': 31,
      'ТипСобытия': 'Тревога', 'НомерТревоги': 1, 'Начало': '2026-11-10T12:00:00', 'Конец': '2026-11-10T13:00:00' });
    assert.equal((await fetch(`${base}/1c/alerts`, { headers: h })).status, 400);

    // тривога через опівніч - два рядки, по одному на кожну добу, нумерація в добі з 1
    const across = ex.filter((x) => x['ДеньМесяца'] === 12 || x['ДеньМесяца'] === 13);
    assert.deepEqual(across.map((x) => [x['ДеньМесяца'], x['НомерТревоги'], x['Начало'], x['Конец']]), [
      [12, 1, '2026-11-12T21:00:00', '2026-11-13T00:00:00'],
      [13, 1, '2026-11-13T00:00:00', '2026-11-13T02:00:00'],
    ]);

    // активна тривога, що перекривається із закритими, не повинна "з'їдати" години
    const redHours = async () => {
      const s = await (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: h })).json() as
        { level: string; hours: number }[];
      return s.find((x) => x.level === 'red')!.hours;
    };
    const hoursBefore = await redHours();
    responses = { 31: [...responses[31], A({ id: 30, level: 'red', startedAt: D('2026-11-10T10:30:00Z') })] };
    await sync(D('2026-11-10T12:00:00Z'));
    assert.ok((await redHours()) > hoursBefore, 'години з активною тривогою не менші, ніж без неї');

    // регіони: додавання з назвою і без, список
    const put = (uid: number, body: object) => fetch(`${base}/regions/${uid}`, {
      method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual(await (await put(27, { title: 'Львівська область' })).json(), { uid: 27, title: 'Львівська область', enabled: true });
    assert.deepEqual(await (await put(99, {})).json(), { uid: 99, title: 'UID 99', enabled: true });
    assert.deepEqual(await (await put(99, { enabled: false })).json(), { uid: 99, title: 'UID 99', enabled: false });
    const regs = await (await fetch(`${base}/regions`, { headers: h })).json() as { uid: number }[];
    assert.ok(regs.some((x) => x.uid === 27));
  } finally {
    server.close();
  }
});

test('ліміт запитів: N за календарну хвилину на ключ, окремо для кожного ключа', () => {
  const limiter = createRateLimiter(2);
  const t = Date.parse('2026-11-14T10:00:10Z');
  assert.equal(limiter(1, t), 0);
  assert.equal(limiter(1, t + 1000), 0);
  assert.equal(limiter(1, t + 2000), 48); // третій у тій самій хвилині -> чекати до 10:01:00
  assert.equal(limiter(2, t + 2000), 0); // інший ключ - свій лічильник
  assert.equal(limiter(1, t + 50_000), 0); // нова хвилина
});

test('захист від підбору: після N невдалих спроб IP блокується до кінця вікна', () => {
  const tracker = createFailureTracker(3, 15 * 60_000);
  const t = Date.parse('2026-11-15T10:00:00Z');
  for (let i = 0; i < 3; i++) {
    assert.equal(tracker.blockedFor('1.1.1.1', t), 0);
    tracker.recordFailure('1.1.1.1', t);
  }
  assert.equal(tracker.blockedFor('1.1.1.1', t + 60_000), 14 * 60); // до 10:15
  assert.equal(tracker.blockedFor('2.2.2.2', t), 0); // інший IP
  assert.equal(tracker.blockedFor('1.1.1.1', t + 15 * 60_000), 0); // нове вікно
});

test('HTTP: 5 неправильних ключів з IP -> 429 навіть з правильним ключем; інший IP працює', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key-long-enough', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (key: string | null, ip: string) => fetch(`${base}/runs?limit=1`, {
    headers: { 'X-Real-IP': ip, ...(key ? { 'X-Api-Key': key } : {}) } });
  try {
    // запити без ключа не рахуються як підбір
    for (let i = 0; i < 12; i++) assert.equal((await get(null, '10.9.0.1')).status, 401);
    assert.equal((await get('admin-key-long-enough', '10.9.0.1')).status, 200);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await get(`wrong-${i}`, '10.9.0.2')).status);
    assert.deepEqual(statuses, [...Array(5).fill(401), 429]);
    const blocked = await get('admin-key-long-enough', '10.9.0.2');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await get('admin-key-long-enough', '10.9.0.3')).status, 200);
    // публічні сторінки з заблокованого IP відкриваються
    assert.equal((await fetch(`${base}/`, { headers: { 'X-Real-IP': '10.9.0.2' } })).status, 200);
  } finally {
    server.close();
  }
});

test('публічне API: клієнтський ключ - лише читання, адмін - усе, вимкнений ключ, CORS, ліміт', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'X-Api-Key': 'admin-key', 'Content-Type': 'application/json' };
  try {
    // адмін створює ключ: згенерований і заданий вручну (поточний ключ клієнта)
    const created = await fetch(`${base}/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'тест' }) });
    assert.equal(created.status, 201);
    const generated = await created.json() as { id: number; key: string };
    assert.ok(generated.key.length >= 32);
    const manual = await fetch(`${base}/keys`, { method: 'POST', headers: admin,
      body: JSON.stringify({ name: '1С', key: 'existing-client-key-123' }) });
    assert.equal(manual.status, 201);
    const duplicate = await fetch(`${base}/keys`, { method: 'POST', headers: admin,
      body: JSON.stringify({ name: 'дубль', key: 'existing-client-key-123' }) });
    assert.equal(duplicate.status, 409);
    assert.equal((await fetch(`${base}/keys`, { method: 'POST', headers: admin,
      body: JSON.stringify({ name: 'короткий', key: 'short' }) })).status, 400);

    // список ключів не містить самих ключів і хешів
    const list = await (await fetch(`${base}/keys`, { headers: admin })).json() as Record<string, unknown>[];
    assert.ok(list.length >= 2);
    assert.ok(list.every((k) => !('key' in k) && !('key_hash' in k)));

    // клієнт: дані - так, адмінські ендпоінти - 403
    const client = { 'X-Api-Key': generated.key };
    const periods = await fetch(`${base}/periods?month=2026-11`, { headers: client });
    assert.equal(periods.status, 200);
    assert.equal(periods.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${base}/runs`, { headers: client })).status, 403);
    assert.equal((await fetch(`${base}/keys`, { headers: client })).status, 403);
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', headers: client })).status, 403);

    // лендінг без ключа
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(landing.headers.get('content-type') ?? '', /text\/html/);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /\/1c\/alerts/);
    assert.match(landingHtml, /<link rel="canonical" href="https:\/\/alerts\.starsam\.net\/">/);
    assert.doesNotMatch(landingHtml, /noindex/);
    // заборона вбудовування в чужі сторінки (клікджекінг) і інші заголовки безпеки
    for (const path of ['/', '/admin', '/periods?month=2026-11']) {
      const r = await fetch(`${base}${path}`, { headers: client });
      assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    }

    // для пошукових систем: robots.txt, sitemap.xml, іконка, HEAD
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    assert.match(robots, /^User-agent: \*/);
    assert.match(robots, /Disallow: \/periods/);
    assert.doesNotMatch(robots, /Disallow: \/\n/); // сам сайт не закритий
    assert.doesNotMatch(robots, /Disallow: \/stats/); // графік лендінгу має рендеритись у Google
    assert.match(robots, /Sitemap: https:\/\/alerts\.starsam\.net\/sitemap\.xml/);
    const sitemap = await fetch(`${base}/sitemap.xml`);
    assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/);
    assert.match(await sitemap.text(), /<loc>https:\/\/alerts\.starsam\.net\/<\/loc><lastmod>\d{4}-\d\d-\d\d<\/lastmod>/);
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /text\/html/);

    // невідомий ключ - 401
    assert.equal((await fetch(`${base}/periods?month=2026-11`, { headers: { 'X-Api-Key': 'nope-nope-nope-nope' } })).status, 401);

    // CORS preflight без ключа
    const pre = await fetch(`${base}/periods`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /X-Api-Key/);

    // ліміт 5/хв: з 12 запитів хоч один - 429 (навіть якщо між ними зміниться хвилина)
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${base}/summary?month=2026-11`, { headers: client })).status);
    assert.ok(statuses.includes(429), JSON.stringify(statuses));
    assert.ok(statuses.every((s) => s === 200 || s === 429), JSON.stringify(statuses));
    // адмін не обмежений
    for (let i = 0; i < 7; i++) assert.equal((await fetch(`${base}/summary?month=2026-11`, { headers: admin })).status, 200);

    // вимкнений ключ - 401; last_used_at заповнено
    const off = await fetch(`${base}/keys/${generated.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    assert.equal(((await off.json()) as { enabled: boolean }).enabled, false);
    assert.equal((await fetch(`${base}/periods?month=2026-11`, { headers: client })).status, 401);
    const row = (await db.query('select last_used_at from api_keys where id = $1', [generated.id])).rows[0];
    assert.ok(row.last_used_at);
    assert.equal((await fetch(`${base}/keys/999999`, { method: 'PUT', headers: admin, body: '{}' })).status, 404);
  } finally {
    server.close();
  }
});

test('заявка на ключ: перевірка полів, збереження, Telegram, пастка для ботів, ліміт з IP', async () => {
  const fake = fakeTelegram();
  const sent = fake.sent;
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: object, ip: string) => fetch(`${base}/key-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(body) });
  const form = { name: 'Іван', company: 'ТОВ "Тест"', purpose: 'звіти в 1С', email: 'ivan@example.com' };
  try {
    // помилки полів (невдалі спроби теж рахуються в ліміт, тому кожна - з іншого IP)
    assert.equal((await post({ ...form, email: 'не-email' }, '10.0.0.1')).status, 400);
    assert.equal((await post({ ...form, name: '  ' }, '10.0.0.2')).status, 400);
    assert.equal((await post({ ...form, purpose: 'x'.repeat(1001) }, '10.0.0.3')).status, 400);

    // успішна заявка: збережено і надіслано, компанія необов'язкова
    const ok = await post({ ...form, company: '' }, '10.0.0.4');
    assert.equal(ok.status, 201);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Іван/);
    assert.match(sent[0].text, /ivan@example\.com/);
    assert.match(sent[0].text, /Компанія: -/);
    assert.doesNotMatch(sent[0].text, /IP|10\.0\.0\.4/); // IP заявника нікуди не йде
    let row = (await db.query(
      'select id, company, telegram_sent, status, telegram_message_id from key_requests order by id desc limit 1')).rows[0];
    assert.deepEqual(sent[0].buttons, [[
      { text: '✅ Прийняти', callback_data: `approve:${row.id}` },
      { text: '❌ Відмовити', callback_data: `reject:${row.id}` },
    ]]);
    assert.deepEqual(row, { id: row.id, company: null, telegram_sent: true, status: 'pending',
      telegram_message_id: sent[0].messageId });

    // бот заповнив приховане поле: 201, але нічого не збережено й не надіслано
    const before = (await db.query('select count(*)::int as n from key_requests')).rows[0].n;
    assert.equal((await post({ ...form, website: 'http://spam' }, '10.0.0.5')).status, 201);
    assert.equal((await db.query('select count(*)::int as n from key_requests')).rows[0].n, before);
    assert.equal(sent.length, 1);

    // Telegram недоступний: заявка все одно збережена, помилка записана
    fake.fail(true);
    assert.equal((await post(form, '10.0.0.6')).status, 201);
    row = (await db.query('select telegram_sent, telegram_error from key_requests order by id desc limit 1')).rows[0];
    assert.equal(row.telegram_sent, false);
    assert.match(row.telegram_error, /Telegram 500/);
    fake.fail(false);

    // ліміт: 3 заявки з одного IP на годину
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(form, '10.0.0.7')).status);
    assert.deepEqual(statuses, [201, 201, 201, 429]);
  } finally {
    server.close();
  }
});

test('кнопки в Telegram: «Прийняти» створює робочий ключ, «Відмовити» - лист з відмовою; секрет і права', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = async (name: string, ip: string) => {
    await fetch(`${base}/key-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify({ name, purpose: 'тест', email: `${name}@example.com` }) });
    return (await db.query('select id from key_requests where name = $1', [name])).rows[0].id as number;
  };
  let clickNo = 0;
  const click = (data: string, fromId = ADMIN_CHAT, secret = fake.telegram.webhookSecret) => fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: ++clickNo, callback_query: { id: `cb${clickNo}`, from: { id: fromId }, data } }),
  });
  const status = async (id: number) => (await db.query('select status, api_key_id from key_requests where id = $1', [id])).rows[0];
  try {
    const approveId = await submit('approve-me', '10.1.0.1');
    const rejectId = await submit('reject-me', '10.1.0.2');

    // без секрету / з чужим секретом - 401, нічого не змінюється
    assert.equal((await click(`approve:${approveId}`, ADMIN_CHAT, 'wrong')).status, 401);
    // не адмін натиснув кнопку - відмова в правах
    assert.equal((await click(`approve:${approveId}`, 999)).status, 200);
    assert.equal(fake.answers.at(-1), 'Немає прав');
    assert.equal((await status(approveId)).status, 'pending');

    // «Прийняти»: ключ створено, повідомлення оновлено без кнопок, лист із ключем надіслано адміну
    assert.equal((await click(`approve:${approveId}`)).status, 200);
    const approved = await status(approveId);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.api_key_id);
    assert.match(fake.edits.at(-1)!.text, new RegExp(`✅ Прийнято .*ключ №${approved.api_key_id}`));
    const letter = fake.sent.at(-1)!.text;
    assert.match(letter, /Кому: approve-me@example\.com/);
    const key = /Ваш ключ API:\n(\S+)/.exec(letter)![1];
    // ключ із листа працює як клієнтський
    assert.equal((await fetch(`${base}/summary?month=2026-11`, { headers: { 'X-Api-Key': key } })).status, 200);
    assert.equal((await fetch(`${base}/runs`, { headers: { 'X-Api-Key': key } })).status, 403);

    // повторне натискання - «вже оброблено», другий ключ не створюється
    const keysBefore = (await db.query('select count(*)::int as n from api_keys')).rows[0].n;
    await click(`approve:${approveId}`);
    assert.equal(fake.answers.at(-1), 'Заявку вже оброблено');
    assert.equal((await db.query('select count(*)::int as n from api_keys')).rows[0].n, keysBefore);

    // «Відмовити»: статус, повідомлення оновлено, лист з відмовою, ключа немає
    await click(`reject:${rejectId}`);
    assert.deepEqual(await status(rejectId), { status: 'rejected', api_key_id: null });
    assert.match(fake.edits.at(-1)!.text, /❌ Відмовлено/);
    assert.match(fake.sent.at(-1)!.text, /Кому: reject-me@example\.com[\s\S]*не можемо надати ключ/);
    // після відмови прийняти вже не можна
    await click(`approve:${rejectId}`);
    assert.equal(fake.answers.at(-1), 'Заявку вже оброблено');
  } finally {
    server.close();
  }
});

test('адмінка: сторінка, список заявок, рішення з адмінки (з оновленням Telegram), видалення ключа', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'X-Api-Key': 'admin-key', 'Content-Type': 'application/json' };
  const submit = async (name: string, ip: string) => {
    await fetch(`${base}/key-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify({ name, purpose: 'адмінка', email: `${name}@example.com` }) });
    return (await db.query('select id from key_requests where name = $1', [name])).rows[0].id as number;
  };
  try {
    // сторінка адмінки відкривається без ключа, але не індексується: заголовок X-Robots-Tag + мета-тег;
    // у robots.txt її немає (інакше робот не побачить noindex, а адреса адмінки стане публічною)
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(await page.text(), /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(await (await fetch(`${base}/robots.txt`)).text(), /admin/);
    assert.equal((await fetch(`${base}/`)).headers.get('x-robots-tag'), null); // лендінг індексується

    const approveId = await submit('admin-approve', '10.2.0.1');
    const rejectId = await submit('admin-reject', '10.2.0.2');

    // список заявок - лише адміну; ті, що чекають, - першими
    const client = await (await fetch(`${base}/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'клієнт' }) })).json();
    assert.equal((await fetch(`${base}/key-requests`, { headers: { 'X-Api-Key': client.key } })).status, 403);
    assert.equal((await fetch(`${base}/key-requests`)).status, 401);
    const list = await (await fetch(`${base}/key-requests`, { headers: admin })).json() as { id: number; status: string }[];
    const firstDecided = list.findIndex((r) => r.status !== 'pending');
    assert.ok(firstDecided === -1 || list.slice(firstDecided).every((r) => r.status !== 'pending'));
    assert.ok(list.some((r) => r.id === approveId));

    // «Прийняти» з адмінки: ключ у відповіді, лист, повідомлення в Telegram оновлено з позначкою «в адмінці»
    const approved = await fetch(`${base}/key-requests/${approveId}/approve`, { method: 'POST', headers: admin });
    assert.equal(approved.status, 200);
    const decision = await approved.json() as { status: string; key: { id: number; value: string }; letter: string };
    assert.equal(decision.status, 'approved');
    assert.match(decision.letter, new RegExp(`Кому: admin-approve@example\\.com[\\s\\S]*${decision.key.value}`));
    assert.match(fake.edits.at(-1)!.text, /✅ Прийнято .*\(в адмінці\)/);
    assert.equal((await fetch(`${base}/summary?month=2026-11`, { headers: { 'X-Api-Key': decision.key.value } })).status, 200);
    // повторно - 409
    assert.equal((await fetch(`${base}/key-requests/${approveId}/reject`, { method: 'POST', headers: admin })).status, 409);

    // у списку ключів видно, кому видано: з заявки - ім'я, email, № заявки; створений вручну - owner null
    const keys = await (await fetch(`${base}/keys`, { headers: admin })).json() as { id: number; owner: unknown }[];
    assert.deepEqual(keys.find((k) => k.id === decision.key.id)?.owner,
      { request_id: approveId, name: 'admin-approve', company: null, email: 'admin-approve@example.com' });
    assert.equal(keys.find((k) => k.id === client.id)?.owner, null);

    // «Відмовити» з адмінки
    const rejected = await (await fetch(`${base}/key-requests/${rejectId}/reject`, { method: 'POST', headers: admin })).json();
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.key, null);
    assert.match(rejected.letter, /не можемо надати ключ/);

    // видалення ключа: ключ перестає працювати, заявка лишається без посилання на ключ
    assert.equal((await fetch(`${base}/keys/${decision.key.id}`, { method: 'DELETE', headers: admin })).status, 200);
    assert.equal((await fetch(`${base}/summary?month=2026-11`, { headers: { 'X-Api-Key': decision.key.value } })).status, 401);
    const row = (await db.query('select status, api_key_id from key_requests where id = $1', [approveId])).rows[0];
    assert.deepEqual(row, { status: 'approved', api_key_id: null });
    assert.equal((await fetch(`${base}/keys/${decision.key.id}`, { method: 'DELETE', headers: admin })).status, 404);
    assert.equal((await fetch(`${base}/keys/${client.id}`, { method: 'DELETE', headers: { 'X-Api-Key': client.key } })).status, 403);
  } finally {
    server.close();
  }
});

test('спостерігач: повідомляє про збійний прогін, про відсутність оновлень і бекапу, нагадує і пише про відновлення', async () => {
  const sent: string[] = [];
  const send = async (text: string) => { sent.push(text); };
  const backupDir = mkdtempSync(join(tmpdir(), 'alerts-backups-'));
  const HOUR = 3_600_000;
  const realNow = Date.now();
  let clock = new Date(realNow);
  const writeDump = (name: string, time: Date) => {
    const file = join(backupDir, name);
    writeFileSync(file, 'dump');
    utimesSync(file, time, time);
  };
  const insertRun = async (status: string, details: object, error: string | null, finishedAt: Date) => {
    await db.query(
      `insert into sync_runs (trigger, status, details, error, finished_at) values ('test', $1, $2, $3, $4)`,
      [status, JSON.stringify(details), error, finishedAt],
    );
  };
  try {
    writeDump('alerts-old.dump', new Date(realNow - HOUR));
    await insertRun('ok', { regions: [{ region: 31 }] }, null, new Date(realNow));
    const monitor = createMonitor(db, send, { backupDir, now: () => clock });

    // перша перевірка: старі прогони не повідомляються, усе свіже - тиша
    await monitor.check();
    assert.deepEqual(sent, []);

    // збійний прогін і прогін з попередженням - по повідомленню; чистий - тиша
    await insertRun('error', { regions: [{ region: 9, error: 'API 401: Invalid API token.' }] }, 'API 401: Invalid API token.', new Date(realNow));
    await insertRun('ok', { regions: [{ region: 14, warning: 'possible gap in data' }] }, null, new Date(realNow));
    await insertRun('ok', { regions: [{ region: 14 }] }, null, new Date(realNow));
    await monitor.check();
    assert.equal(sent.length, 2);
    assert.match(sent[0], /❌ Прогін №\d+ \(test\): error[\s\S]*Регіон 9: API 401/);
    assert.match(sent[1], /⚠️ Прогін №\d+ \(test\): ok[\s\S]*Регіон 14: possible gap/);

    // минуло 30 год без вдалих прогонів і бекапів - два повідомлення
    clock = new Date(realNow + 30 * HOUR);
    await monitor.check();
    assert.equal(sent.length, 4);
    assert.match(sent[2], /Немає вдалого оновлення даних понад 26 год/);
    assert.match(sent[3], /Бекап бази не робився понад 26 год[\s\S]*alerts-old\.dump/);

    // через годину - без повторів; через 12 год - нагадування
    clock = new Date(realNow + 31 * HOUR);
    await monitor.check();
    assert.equal(sent.length, 4);
    clock = new Date(realNow + 43 * HOUR);
    await monitor.check();
    assert.equal(sent.length, 6);

    // з'явився вдалий прогін і свіжий бекап - «відновлено»
    await insertRun('ok', { regions: [{ region: 31 }] }, null, clock);
    writeDump('alerts-new.dump', clock);
    await monitor.check();
    assert.equal(sent.length, 8);
    assert.match(sent[6], /✅ Оновлення даних знову працює/);
    assert.match(sent[7], /✅ Бекап бази знову є: alerts-new\.dump/);
    await monitor.check();
    assert.equal(sent.length, 8);
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test('вебхук Telegram: якщо реєстрація не вдалася - повторює у фоні, доки не вдасться', async () => {
  let calls = 0;
  const registered: string[] = [];
  const api: TelegramApi = {
    sendMessage: async () => 1,
    editMessage: async () => {},
    answerCallback: async () => {},
    setWebhook: async (url) => {
      calls++;
      if (calls <= 2) throw new Error('Telegram недоступний');
      registered.push(url);
    },
  };
  const first = await registerWebhook(api, 'https://example.test/telegram/webhook', 'secret', [10, 20]);
  assert.equal(first, false); // перша спроба невдала, далі - у фоні
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 3); // 2 невдалі + 1 вдала, далі спроби припиняються
  assert.deepEqual(registered, ['https://example.test/telegram/webhook']);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 3);
});

test('написати автору: поля, збереження, Telegram, пастка для ботів, помилка Telegram, ліміт з IP', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: object, ip: string) => fetch(`${base}/contact`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(body) });
  const msg = { name: 'Олена', contact: '@olena', message: 'У Бучанському районі\nне вистачає тривоги за 10.11' };
  const count = async () => (await db.query('select count(*)::int as n from contact_messages')).rows[0].n as number;
  try {
    assert.equal((await post({ ...msg, contact: ' ' }, '10.3.0.1')).status, 400);
    assert.equal((await post({ ...msg, message: 'x'.repeat(3001) }, '10.3.0.2')).status, 400);

    const ok = await post(msg, '10.3.0.3');
    assert.equal(ok.status, 201);
    assert.match(fake.sent.at(-1)!.text, /✉️ Повідомлення з сайту №\d+\nВід: Олена\nДля відповіді: @olena\n\nУ Бучанському районі\nне вистачає/);
    assert.equal(fake.sent.at(-1)!.buttons, undefined);
    // надіслане в Telegram у базі не лишається
    assert.equal(await count(), 0);

    // бот: 201, але нічого не збережено й не надіслано
    const before = await count();
    const sentBefore = fake.sent.length;
    assert.equal((await post({ ...msg, website: 'spam' }, '10.3.0.4')).status, 201);
    assert.equal(await count(), before);
    assert.equal(fake.sent.length, sentBefore);

    // Telegram недоступний: повідомлення лишається в базі з помилкою (не губиться)
    fake.fail(true);
    assert.equal((await post(msg, '10.3.0.5')).status, 201);
    const failed = (await db.query('select name, telegram_error from contact_messages order by id desc limit 1')).rows[0];
    assert.equal(failed.name, 'Олена');
    assert.match(failed.telegram_error, /Telegram 500/);
    assert.equal(await count(), 1);
    fake.fail(false);

    // ліміт: 5 повідомлень з одного IP на годину
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(msg, '10.3.0.6')).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  } finally {
    server.close();
  }
});

test('недоставлені повідомлення автору: монітор досилає їх і видаляє; поки Telegram лежить - лишаються', async () => {
  await db.query(
    `insert into contact_messages (name, contact, message, telegram_error) values
       ('Андрій', 'a@example.com', 'перше', 'Telegram 502'),
       ('Марія', '@maria', 'друге', 'Telegram 502')`,
  );
  const pending = async () => (await db.query('select count(*)::int as n from contact_messages')).rows[0].n as number;
  const total = await pending();
  assert.ok(total >= 2);

  // Telegram досі недоступний: нічого не видалено, помилку оновлено
  const failing = createMonitor(db, async () => { throw new Error('Telegram 503: still down'); }, { backupDir: null });
  await failing.check(); // перша перевірка лише ініціалізує журнал прогонів
  await failing.check();
  assert.equal(await pending(), total);
  const errors = (await db.query('select telegram_error from contact_messages order by id limit 1')).rows[0];
  assert.match(errors.telegram_error, /503/);

  // Telegram запрацював: усе доставлено з позначкою, таблиця порожня
  const sent: string[] = [];
  const working = createMonitor(db, async (text) => { sent.push(text); }, { backupDir: null });
  await working.check();
  const contacts = sent.filter((text) => text.startsWith('✉️'));
  assert.equal(contacts.length, total);
  assert.ok(contacts.some((text) => /Від: Марія\nДля відповіді: @maria\n\nдруге\n\n\(доставлено із запізненням\)/.test(text)));
  assert.equal(await pending(), 0);
});

test('публічна статистика /stats: без ключа, регіони за спаданням годин, червоні години не більші за всі, кеш', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=600/);
    const stats = await res.json() as { from: string; to: string; days: number;
      regions: { uid: number; title: string; hours: number; red_hours: number; alerts: number }[] };
    assert.equal(stats.days, 30);
    assert.match(stats.from, /^\d{4}-\d\d-\d\d$/);
    assert.ok(stats.regions.length > 0);
    assert.ok(stats.regions.every((r, i) => i === 0 || stats.regions[i - 1].hours >= r.hours), 'за спаданням');
    assert.ok(stats.regions.every((r) => r.red_hours <= r.hours + 0.05 && Number.isInteger(r.alerts)));
    assert.ok(stats.regions.every((r) => !('location_uid' in r)), 'лише агрегат по регіонах');
    // другий запит - з кешу (той самий updated_at)
    const again = await (await fetch(`${base}/stats`)).json() as { updated_at: string };
    assert.equal(again.updated_at, (stats as unknown as { updated_at: string }).updated_at);
  } finally {
    server.close();
  }
});
