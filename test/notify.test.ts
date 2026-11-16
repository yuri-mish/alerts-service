// Спостерігач і «Написати автору»: повідомлення в Telegram, досилання недоставленого.
// Потрібен Postgres: DATABASE_URL (тести працюють в окремій схемі).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/http/server.ts';
import { createMonitor } from '../src/notify/monitor.ts';
import { db, fetcher, fakeTelegram } from './helpers.ts';
import type { AddressInfo } from 'node:net';

test('спостерігач: повідомляє про збійний прогін, про відсутність оновлень і бекапу, нагадує і пише про відновлення', async () => {
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
  };
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
    await insertRun(
      'error',
      { regions: [{ region: 9, error: 'API 401: Invalid API token.' }] },
      'API 401: Invalid API token.',
      new Date(realNow),
    );
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

test('написати автору: поля, збереження, Telegram, пастка для ботів, помилка Telegram, ліміт з IP', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: object, ip: string) =>
    fetch(`${base}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify(body),
    });
  const msg = { name: 'Олена', contact: '@olena', message: 'У Бучанському районі\nне вистачає тривоги за 10.11' };
  const count = async () => (await db.query('select count(*)::int as n from contact_messages')).rows[0].n as number;
  try {
    assert.equal((await post({ ...msg, contact: ' ' }, '10.3.0.1')).status, 400);
    assert.equal((await post({ ...msg, message: 'x'.repeat(3001) }, '10.3.0.2')).status, 400);

    const ok = await post(msg, '10.3.0.3');
    assert.equal(ok.status, 201);
    assert.match(
      fake.sent.at(-1)!.text,
      /✉️ Повідомлення з сайту №\d+\nВід: Олена\nДля відповіді: @olena\n\nУ Бучанському районі\nне вистачає/,
    );
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
    const failed = (await db.query('select name, telegram_error from contact_messages order by id desc limit 1'))
      .rows[0];
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
  const failing = createMonitor(
    db,
    async () => {
      throw new Error('Telegram 503: still down');
    },
    { backupDir: null },
  );
  await failing.check(); // перша перевірка лише ініціалізує журнал прогонів
  await failing.check();
  assert.equal(await pending(), total);
  const errors = (await db.query('select telegram_error from contact_messages order by id limit 1')).rows[0];
  assert.match(errors.telegram_error, /503/);

  // Telegram запрацював: усе доставлено з позначкою, таблиця порожня
  const sent: string[] = [];
  const working = createMonitor(
    db,
    async (text) => {
      sent.push(text);
    },
    { backupDir: null },
  );
  await working.check();
  const contacts = sent.filter((text) => text.startsWith('✉️'));
  assert.equal(contacts.length, total);
  assert.ok(
    contacts.some((text) => /Від: Марія\nДля відповіді: @maria\n\nдруге\n\n\(доставлено із запізненням\)/.test(text)),
  );
  assert.equal(await pending(), 0);
});
