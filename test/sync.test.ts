// Синхронізація: розрізання по добах і місяцях, рівні, зависання, пакетний запис, типи тривог, підрегіони.
// Потрібен Postgres: DATABASE_URL (тести працюють в окремій схемі).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, A, D, fakeApi, sync, periods } from './helpers.ts';

test('тривога на межі місяців розрізається на дві частини (київський час)', async () => {
  // 31.10 23:40 -> 01.11 00:30 за Києвом (UTC+2 після 25.10)
  fakeApi.responses = {
    31: [A({ id: 1, startedAt: D('2026-10-31T21:40:00Z'), finishedAt: D('2026-10-31T22:30:00Z') })],
  };
  await sync(D('2026-11-02T00:00:00Z'));
  assert.deepEqual(await periods(1), [
    {
      level: 'yellow',
      month: '2026-10',
      day: '2026-10-31',
      duration_min: 20,
      s: '2026-10-31 23:40',
      f: '2026-11-01 00:00',
    },
    {
      level: 'yellow',
      month: '2026-11',
      day: '2026-11-01',
      duration_min: 30,
      s: '2026-11-01 00:00',
      f: '2026-11-01 00:30',
    },
  ]);
});

test('тривога через опівніч розрізається по київських добах', async () => {
  // 12.11 21:00 -> 13.11 02:00 за Києвом (UTC+2)
  fakeApi.responses = {
    31: [A({ id: 12, startedAt: D('2026-11-12T19:00:00Z'), finishedAt: D('2026-11-13T00:00:00Z') })],
  };
  await sync(D('2026-11-14T00:00:00Z'));
  assert.deepEqual(await periods(12), [
    {
      level: 'yellow',
      month: '2026-11',
      day: '2026-11-12',
      duration_min: 180,
      s: '2026-11-12 21:00',
      f: '2026-11-13 00:00',
    },
    {
      level: 'yellow',
      month: '2026-11',
      day: '2026-11-13',
      duration_min: 120,
      s: '2026-11-13 00:00',
      f: '2026-11-13 02:00',
    },
  ]);
});

test('рівень: лишається останній відомий, зміни рівня не розділяють тривогу', async () => {
  fakeApi.responses = { 31: [A({ id: 2, level: 'yellow', startedAt: D('2026-11-05T10:00:00Z') })] };
  await sync(D('2026-11-05T10:10:00Z'));
  let p = await periods(2);
  assert.equal(p.length, 1);
  assert.equal(p[0].level, 'yellow');
  assert.equal(p[0].f, null); // ще триває
  assert.equal(p[0].duration_min, null);

  fakeApi.responses = {
    31: [
      A({
        id: 2,
        level: 'red',
        startedAt: D('2026-11-05T10:00:00Z'),
        updatedAt: D('2026-11-05T10:20:00Z'),
        finishedAt: D('2026-11-05T10:50:00Z'),
      }),
    ],
  };
  const r = await sync(D('2026-11-05T11:00:00Z'));
  assert.equal(r.regions.find((x) => x.region === 31)?.updated, 1);
  p = await periods(2);
  assert.deepEqual(
    p.map((x) => [x.level, x.duration_min]),
    [['red', 50]],
  ); // один відрізок, останній рівень

  // повторний прогін з тими ж даними нічого не змінює
  const again = await sync(D('2026-11-05T12:00:00Z'));
  assert.equal(again.regions.find((x) => x.region === 31)?.updated, 0);
  assert.equal((await periods(2)).length, 1);
});

test('зависла понад 3 доби тривога закривається як 30 хв, справжній кінець з API її замінює', async () => {
  fakeApi.responses = { 31: [A({ id: 3, startedAt: D('2026-11-06T08:00:00Z') })] };
  await sync(D('2026-11-09T07:00:00Z')); // 71 год без кінця - ще не чіпаємо
  let a = (await db.query('select closed_by, finished_at from alerts where id = 3')).rows[0];
  assert.equal(a.finished_at, null);
  assert.equal(a.closed_by, null);

  await sync(D('2026-11-09T09:00:00Z')); // 73 год
  a = (await db.query('select closed_by from alerts where id = 3')).rows[0];
  assert.equal(a.closed_by, 'stale_30min');
  assert.deepEqual(
    (await periods(3)).map((x) => x.duration_min),
    [30],
  );

  // API досі без кінця - лишається наше закриття
  await sync(D('2026-11-09T10:00:00Z'));
  assert.deepEqual(
    (await periods(3)).map((x) => x.duration_min),
    [30],
  );

  fakeApi.responses = {
    31: [A({ id: 3, startedAt: D('2026-11-06T08:00:00Z'), finishedAt: D('2026-11-06T08:45:00Z') })],
  };
  await sync(D('2026-11-09T11:00:00Z'));
  a = (await db.query('select closed_by from alerts where id = 3')).rows[0];
  assert.equal(a.closed_by, 'api');
  assert.deepEqual(
    (await periods(3)).map((x) => x.duration_min),
    [45],
  );
});

test('пакетний запис: дубль id у відповіді не ламає прогін, незмінена тривога лише оновлює last_seen_at', async () => {
  const same = A({ id: 20, startedAt: D('2026-11-09T10:00:00Z'), finishedAt: D('2026-11-09T10:30:00Z') });
  fakeApi.responses = {
    31: [same, same, A({ id: 21, startedAt: D('2026-11-09T11:00:00Z'), finishedAt: D('2026-11-09T11:10:00Z') })],
  };
  const first = (await sync(D('2026-11-09T12:00:00Z'))).regions.find((x) => x.region === 31);
  assert.equal(first?.fetched, 3);
  assert.equal(first?.inserted, 2); // 20 і 21; дубль не вставляється вдруге
  assert.deepEqual(
    (await periods(20)).map((x) => x.duration_min),
    [30],
  );

  const second = (await sync(D('2026-11-09T13:00:00Z'))).regions.find((x) => x.region === 31);
  assert.equal(second?.inserted, 0);
  assert.equal(second?.updated, 0);
  const seen = (await db.query('select last_seen_at from alerts where id = any($1)', [[20, 21]])).rows;
  assert.deepEqual(
    seen.map((x) => x.last_seen_at.toISOString()),
    ['2026-11-09T13:00:00.000Z', '2026-11-09T13:00:00.000Z'],
  );
});

test('у звіти йдуть лише air_raid: артобстріл зберігається в alerts, але відрізків не має', async () => {
  fakeApi.responses = {
    31: [
      // жовтень - щоб не заважати іншим тестам, що рахують листопад
      A({ id: 40, alertType: 'air_raid', startedAt: D('2026-10-20T10:00:00Z'), finishedAt: D('2026-10-20T10:30:00Z') }),
      A({
        id: 41,
        alertType: 'artillery_shelling',
        startedAt: D('2026-10-20T10:00:00Z'),
        finishedAt: D('2026-10-20T11:00:00Z'),
      }),
    ],
  };
  await sync(D('2026-10-20T12:00:00Z'));
  const stored = (await db.query('select id, alert_type from alerts where id = any($1) order by id', [[40, 41]])).rows;
  assert.deepEqual(stored, [
    { id: 40, alert_type: 'air_raid' },
    { id: 41, alert_type: 'artillery_shelling' },
  ]);
  assert.deepEqual(
    (await periods(40)).map((x) => x.duration_min),
    [30],
  );
  assert.deepEqual(await periods(41), []);
});

test('підрегіони: location_uid зберігається, регіон запиту - окремо', async () => {
  fakeApi.responses = {
    14: [
      A({
        id: 4,
        locationUid: 94,
        locationTitle: 'Бучанська громада',
        locationType: 'hromada',
        level: 'red',
        startedAt: D('2026-11-08T10:00:00Z'),
        finishedAt: D('2026-11-08T10:30:00Z'),
      }),
    ],
  };
  await sync(D('2026-11-08T12:00:00Z'));
  const r = (await db.query('select region_uid, location_uid, level from alert_periods where alert_id = 4')).rows;
  assert.deepEqual(r, [{ region_uid: 14, location_uid: 94, level: 'red' }]);
});
