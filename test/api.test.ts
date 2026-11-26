// HTTP API: ключі, ліміти, захист від підбору, права клієнта й адміна, /summary, /periods, /stats.
// Потрібен Postgres: DATABASE_URL (тести працюють в окремій схемі).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/http/server.ts';
import { db, A, D, fakeApi, fetcher, sync } from './helpers.ts';
import type { AddressInfo } from 'node:net';

test("HTTP: ключ, /summary з об'єднанням перекриттів, /periods csv", async () => {
  fakeApi.responses = {
    31: [
      A({ id: 10, level: 'red', startedAt: D('2026-11-10T10:00:00Z'), finishedAt: D('2026-11-10T11:00:00Z') }),
      A({ id: 11, level: 'red', startedAt: D('2026-11-10T10:30:00Z'), finishedAt: D('2026-11-10T11:30:00Z') }),
      // жовта після двох червоних тієї ж доби: у вигрузці 1С - №3 і з фільтром level, і без
      A({ id: 13, startedAt: D('2026-11-10T12:00:00Z'), finishedAt: D('2026-11-10T12:20:00Z') }),
      // жовта через київську північ: 12.11 21:00 - 13.11 02:00
      A({ id: 12, startedAt: D('2026-11-12T19:00:00Z'), finishedAt: D('2026-11-13T00:00:00Z') }),
    ],
  };
  await sync(D('2026-11-11T00:00:00Z'));

  const server = createServer({ db, fetcher, adminKey: 'k', rateLimitPerMin: 1000, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/summary?month=2026-11&region=31`)).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);

    const h = { 'X-Api-Key': 'k' };
    const sum = (await (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: h })).json()) as {
      level: string;
      alerts: number;
      hours: number;
    }[];
    const red = sum.find((x) => x.level === 'red');
    assert.ok(red, JSON.stringify(sum));
    // 10:00-11:00 і 10:30-11:30 перекриваються -> 1.5 год, а не 2
    assert.equal(red.hours, 1.5);
    assert.ok(sum.find((x) => x.level === 'all'));

    const res = await fetch(`${base}/periods?month=2026-11&region=31&level=red&format=csv`, { headers: h });
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM для Excel
    const text = bytes.subarray(3).toString('utf8');
    assert.ok(text.startsWith('region_uid;location_uid;location_title'), text.slice(0, 80));
    assert.equal(text.trim().split('\r\n').length, 1 + 2); // заголовок + дві червоні тривоги

    assert.equal((await fetch(`${base}/periods?month=2026-13&region=31`, { headers: h })).status, 400);
    // без території (ні region, ні location) - усі області; без month - 400 (обов'язковий лише він)
    for (const path of ['/periods', '/summary', '/1c/alerts']) {
      const allRegions = await fetch(`${base}${path}?month=2026-11`, { headers: h });
      assert.equal(allRegions.status, 200, path);
      assert.ok(((await allRegions.json()) as unknown[]).length > 0, path);
      const noMonth = await fetch(`${base}${path}?region=31`, { headers: h });
      assert.equal(noMonth.status, 400, path);
      assert.deepEqual(await noMonth.json(), { error: 'month: required (YYYY-MM)' }, path);
    }

    // вигрузка для 1С
    const ex = (await (await fetch(`${base}/1c/alerts?month=2026-11&region=31`, { headers: h })).json()) as Record<
      string,
      unknown
    >[];
    const d10 = ex.filter((x) => x['ДеньМесяца'] === 10);
    assert.deepEqual(
      d10.map((x) => x['НомерТревоги']),
      [1, 2, 3],
    );
    // фільтр за рівнем: нумерація лишається по всіх тривогах доби (жовта - №3, а не №1)
    const yellowOnly = (await (
      await fetch(`${base}/1c/alerts?month=2026-11&region=31&level=yellow`, { headers: h })
    ).json()) as Record<string, unknown>[];
    assert.deepEqual(
      yellowOnly.map((x) => [x['ДеньМесяца'], x['НомерТревоги']]),
      [
        [10, 3],
        [12, 1],
        [13, 1],
      ],
    );
    // невідомий параметр (опечатка) - 400, а не мовчазне ігнорування
    const typo = await fetch(`${base}/1c/alerts?month=2026-11&region=31&levle=red`, { headers: h });
    assert.equal(typo.status, 400);
    assert.deepEqual(await typo.json(), { error: 'Unrecognized key: "levle"' });
    assert.deepEqual(d10[0], {
      ПериодМесяц: '2026-11-01T00:00:00',
      ДеньМесяца: 10,
      КодТеритории: 31,
      ТипСобытия: 'Тревога',
      НомерТревоги: 1,
      Начало: '2026-11-10T12:00:00',
      Конец: '2026-11-10T13:00:00',
    });
    assert.equal((await fetch(`${base}/1c/alerts`, { headers: h })).status, 400);

    // тривога через опівніч - два рядки, по одному на кожну добу, нумерація в добі з 1
    const across = ex.filter((x) => x['ДеньМесяца'] === 12 || x['ДеньМесяца'] === 13);
    assert.deepEqual(
      across.map((x) => [x['ДеньМесяца'], x['НомерТревоги'], x['Начало'], x['Конец']]),
      [
        [12, 1, '2026-11-12T21:00:00', '2026-11-13T00:00:00'],
        [13, 1, '2026-11-13T00:00:00', '2026-11-13T02:00:00'],
      ],
    );

    // активна тривога, що перекривається із закритими, не повинна "з'їдати" години
    const redHours = async () => {
      const s = (await (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: h })).json()) as {
        level: string;
        hours: number;
      }[];
      return s.find((x) => x.level === 'red')!.hours;
    };
    const hoursBefore = await redHours();
    fakeApi.responses = {
      31: [...fakeApi.responses[31], A({ id: 30, level: 'red', startedAt: D('2026-11-10T10:30:00Z') })],
    };
    await sync(D('2026-11-10T12:00:00Z'));
    assert.ok((await redHours()) > hoursBefore, 'години з активною тривогою не менші, ніж без неї');

    // регіони: додавання з назвою і без, список
    const put = (uid: number, body: object) =>
      fetch(`${base}/regions/${uid}`, {
        method: 'PUT',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.deepEqual(await (await put(27, { title: 'Львівська область' })).json(), {
      uid: 27,
      title: 'Львівська область',
      enabled: true,
    });
    assert.deepEqual(await (await put(99, {})).json(), { uid: 99, title: 'UID 99', enabled: true });
    assert.deepEqual(await (await put(99, { enabled: false })).json(), { uid: 99, title: 'UID 99', enabled: false });
    const regs = (await (await fetch(`${base}/regions`, { headers: h })).json()) as { uid: number }[];
    assert.ok(regs.some((x) => x.uid === 27));
  } finally {
    server.close();
  }
});

test('HTTP: 5 неправильних ключів з IP -> 429 навіть з правильним ключем; інший IP працює', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key-long-enough', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (key: string | null, ip: string) =>
    fetch(`${base}/runs?limit=1`, {
      headers: { 'X-Real-IP': ip, ...(key ? { 'X-Api-Key': key } : {}) },
    });
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
    const created = await fetch(`${base}/keys`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: 'тест' }),
    });
    assert.equal(created.status, 201);
    const generated = (await created.json()) as { id: number; key: string };
    assert.ok(generated.key.length >= 32);
    const manual = await fetch(`${base}/keys`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: '1С', key: 'existing-client-key-123' }),
    });
    assert.equal(manual.status, 201);
    const duplicate = await fetch(`${base}/keys`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: 'дубль', key: 'existing-client-key-123' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (
        await fetch(`${base}/keys`, {
          method: 'POST',
          headers: admin,
          body: JSON.stringify({ name: 'короткий', key: 'short' }),
        })
      ).status,
      400,
    );

    // список ключів не містить самих ключів і хешів
    const list = (await (await fetch(`${base}/keys`, { headers: admin })).json()) as Record<string, unknown>[];
    assert.ok(list.length >= 2);
    assert.ok(list.every((k) => !('key' in k) && !('key_hash' in k)));

    // клієнт: дані - так, адмінські ендпоінти - 403
    const client = { 'X-Api-Key': generated.key };
    const periods = await fetch(`${base}/periods?month=2026-11&region=31`, { headers: client });
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
    for (const path of ['/', '/admin', '/periods?month=2026-11&region=31']) {
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
    assert.match(
      await sitemap.text(),
      /<loc>https:\/\/alerts\.starsam\.net\/<\/loc><lastmod>\d{4}-\d\d-\d\d<\/lastmod>/,
    );
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/og-image.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/hero-bg.jpg`)).headers.get('content-type'), 'image/jpeg');
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /text\/html/);

    // невідомий ключ - 401
    assert.equal(
      (await fetch(`${base}/periods?month=2026-11&region=31`, { headers: { 'X-Api-Key': 'nope-nope-nope-nope' } }))
        .status,
      401,
    );

    // CORS preflight без ключа
    const pre = await fetch(`${base}/periods`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /X-Api-Key/);

    // ліміт 5/хв: з 12 запитів хоч один - 429 (навіть якщо між ними зміниться хвилина)
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await fetch(`${base}/summary?month=2026-11&region=31`, { headers: client })).status);
    assert.ok(statuses.includes(429), JSON.stringify(statuses));
    assert.ok(
      statuses.every((s) => s === 200 || s === 429),
      JSON.stringify(statuses),
    );
    // адмін не обмежений
    for (let i = 0; i < 7; i++)
      assert.equal((await fetch(`${base}/summary?month=2026-11&region=31`, { headers: admin })).status, 200);

    // вимкнений ключ - 401; last_used_at заповнено
    const off = await fetch(`${base}/keys/${generated.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(((await off.json()) as { enabled: boolean }).enabled, false);
    assert.equal((await fetch(`${base}/periods?month=2026-11&region=31`, { headers: client })).status, 401);
    const row = (await db.query('select last_used_at from api_keys where id = $1', [generated.id])).rows[0];
    assert.ok(row.last_used_at);
    assert.equal((await fetch(`${base}/keys/999999`, { method: 'PUT', headers: admin, body: '{}' })).status, 404);
  } finally {
    server.close();
  }
});

test('публічна статистика /stats: без ключа, регіони за спаданням годин, червоні години не більші за всі, кеш', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=600/);
    const stats = (await res.json()) as {
      from: string;
      to: string;
      days: number;
      regions: { uid: number; title: string; hours: number; red_hours: number; alerts: number }[];
    };
    assert.equal(stats.days, 30);
    assert.match(stats.from, /^\d{4}-\d\d-\d\d$/);
    assert.ok(stats.regions.length > 0);
    assert.ok(
      stats.regions.every((r, i) => i === 0 || stats.regions[i - 1].hours >= r.hours),
      'за спаданням',
    );
    assert.ok(stats.regions.every((r) => r.red_hours <= r.hours + 0.05 && Number.isInteger(r.alerts)));
    assert.ok(
      stats.regions.every((r) => !('location_uid' in r)),
      'лише агрегат по регіонах',
    );
    // другий запит - з кешу (той самий updated_at)
    const again = (await (await fetch(`${base}/stats`)).json()) as { updated_at: string };
    assert.equal(again.updated_at, (stats as unknown as { updated_at: string }).updated_at);
  } finally {
    server.close();
  }
});

test('документація API: /openapi.json зі схем zod, сторінка /docs і файли Swagger UI - без ключа', async () => {
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
      openapi: string;
      paths: Record<string, { get: { parameters: { name: string; required: boolean }[] } }>;
    };
    assert.equal(spec.openapi, '3.1.0');
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/1c/alerts', '/alerts/{id}', '/periods', '/summary']);
    const month = spec.paths['/1c/alerts'].get.parameters.find((p) => p.name === 'month');
    assert.equal(month?.required, true, 'month обов’язковий для /1c/alerts');
    assert.equal(spec.paths['/periods'].get.parameters.find((p) => p.name === 'month')?.required, true);
    // у кожного коду помилки - свої приклади (а не той самий текст)
    const responses = (
      spec.paths['/periods'].get as unknown as {
        responses: Record<
          string,
          { content: { 'application/json': { examples: Record<string, { value: { error: string } }> } } }
        >;
      }
    ).responses;
    const errorsOf = (code: string) =>
      Object.values(responses[code].content['application/json'].examples).map((e) => e.value.error);
    assert.ok(errorsOf('400').includes('month: required (YYYY-MM)'));
    assert.deepEqual(errorsOf('401'), ['X-Api-Key required']);
    assert.ok(errorsOf('429').every((error) => /retry in \d+s$/.test(error)));

    const page = await fetch(`${base}/docs`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /swagger-ui-bundle\.js/);
    const bundle = await fetch(`${base}/docs/assets/swagger-ui-bundle.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
  } finally {
    server.close();
  }
});
