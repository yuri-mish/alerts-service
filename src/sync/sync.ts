import { tx, type Client, type Db } from '../core/db.ts';
import { ApiError, type ApiAlert, type Fetcher } from './alerts-api.ts';
import { log } from '../core/log.ts';
import { config } from '../core/config.ts';

const STALE_AFTER_H = 72;      // тривога "висить" довше (3 доби) - закриваємо
const STALE_DURATION_MIN = 30; // ... тривалістю 30 хв
const GAP_WARN_DAYS = 25;      // API віддає ~30 днів; довша перерва = можлива дірка
const LOCK_KEY = 7_310_031;    // pg advisory lock: один прогін одночасно
// У звіти (alert_periods) йдуть лише повітряні тривоги; інші типи (artillery_shelling, urban_fights, ...)
// зберігаються в alerts, але не рахуються (вимога користувача, 14.11.2026)
const REPORT_ALERT_TYPE = 'air_raid';

export type ApplyStats = { fetched: number; inserted: number; updated: number };

// Поточний стан тривоги в базі
type CurrentAlert = {
  id: number;
  finished_at: Date | null;
  closed_by: string | null;
  level: string | null;
  location_title: string;
  api_updated_at: Date | null;
};

type ApplyFlags = { changed: boolean; rowChanged: boolean };

const t = (d: Date | null) => (d ? d.getTime() : null);

/** Одним запитом читає (і блокує) наявні тривоги. */
const loadCurrent = async (c: Client, ids: number[]): Promise<Map<number, CurrentAlert>> => {
  const result = await c.query<CurrentAlert>(
    `select id, finished_at, closed_by, level, location_title, api_updated_at
       from alerts where id = any($1) for update`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
};

/** Нові тривоги: один пакетний запит. */
const insertFresh = async (c: Client, regionUid: number, fresh: ApiAlert[], now: Date): Promise<void> => {
  if (!fresh.length) return;
  await c.query(
    `insert into alerts (id, region_uid, location_uid, location_title, location_type, alert_type, level,
                         started_at, finished_at, closed_by, api_updated_at, last_seen_at)
     select f.id, $1::int, f.location_uid, f.location_title, f.location_type, f.alert_type, f.level,
            f.started_at, f.finished_at, f.closed_by, f.api_updated_at, $2::timestamptz
       from unnest($3::bigint[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[],
                   $9::timestamptz[], $10::timestamptz[], $11::text[], $12::timestamptz[])
         as f(id, location_uid, location_title, location_type, alert_type, level,
              started_at, finished_at, closed_by, api_updated_at)`,
    [
      regionUid, now,
      fresh.map((a) => a.id),
      fresh.map((a) => a.locationUid),
      fresh.map((a) => a.locationTitle),
      fresh.map((a) => a.locationType),
      fresh.map((a) => a.alertType),
      fresh.map((a) => a.level),
      fresh.map((a) => a.startedAt),
      fresh.map((a) => a.finishedAt),
      fresh.map((a) => (a.finishedAt ? 'api' : null)),
      fresh.map((a) => a.updatedAt),
    ],
  );
};

/** Тривога, що вже є в базі: оновлює кінець, назву і рівень (лишається останній відомий). */
const applyExisting = async (c: Client, a: ApiAlert, cur: CurrentAlert, now: Date): Promise<ApplyFlags> => {
  // Кінець: API -> справжній; якщо ми закрили як "завислу", а API досі без кінця - лишаємо наш
  let finishedAt = cur.finished_at;
  let closedBy = cur.closed_by;
  if (a.finishedAt) {
    finishedAt = a.finishedAt;
    closedBy = 'api';
  } else if (cur.closed_by !== 'stale_30min') {
    finishedAt = null;
    closedBy = null;
  }

  // Рівень: зміни не відстежуємо, зберігаємо останній відомий
  const newLevel = a.level ?? cur.level;

  const changed = t(cur.finished_at) !== t(finishedAt) || cur.closed_by !== closedBy
    || newLevel !== cur.level || cur.location_title !== a.locationTitle;
  const rowChanged = changed || t(cur.api_updated_at) !== t(a.updatedAt);

  if (rowChanged) {
    await c.query(
      `update alerts set finished_at = $2, closed_by = $3, level = $4, location_title = $5,
         api_updated_at = $6, last_seen_at = $7 where id = $1`,
      [a.id, finishedAt, closedBy, newLevel, a.locationTitle, a.updatedAt, now],
    );
  }
  return { changed, rowChanged };
};

/** Записує тривоги одного регіону. Повертає id змінених тривог через `touched`. */
export const applyAlerts = async (
  c: Client,
  regionUid: number,
  alerts: ApiAlert[],
  now: Date,
  touched: Set<number>,
): Promise<ApplyStats> => {
  const st: ApplyStats = { fetched: alerts.length, inserted: 0, updated: 0 };

  // той самий id двічі у відповіді не повинен ламати пакетну вставку - лишається останній
  const unique = [...new Map(alerts.map((a) => [a.id, a])).values()];
  const current = await loadCurrent(c, unique.map((a) => a.id));

  const fresh: ApiAlert[] = [];
  const onlySeenIds: number[] = []; // нічого не змінилось - достатньо оновити last_seen_at
  for (const a of unique) {
    const cur = current.get(a.id);
    if (!cur) {
      fresh.push(a);
      continue;
    }
    const { changed, rowChanged } = await applyExisting(c, a, cur, now);
    if (changed) {
      st.updated++;
      touched.add(a.id);
    }
    if (!rowChanged) onlySeenIds.push(a.id);
  }

  await insertFresh(c, regionUid, fresh, now);
  st.inserted = fresh.length;
  fresh.forEach((a) => touched.add(a.id));

  if (onlySeenIds.length) {
    await c.query('update alerts set last_seen_at = $2 where id = any($1)', [onlySeenIds, now]);
  }
  return st;
};

/** Тривоги без кінця довше STALE_AFTER_H (3 доби) закриваються як початок + 30 хв. */
export const closeStale = async (c: Client, now: Date, touched: Set<number>): Promise<number> => {
  const ids = (await c.query<{ id: number }>(
    `update alerts set finished_at = started_at + make_interval(mins => $2), closed_by = 'stale_30min'
      where finished_at is null and started_at < $1::timestamptz - make_interval(hours => $3)
      returning id`,
    [now, STALE_DURATION_MIN, STALE_AFTER_H],
  )).rows.map((r) => r.id);
  ids.forEach((id) => touched.add(id));
  return ids.length;
};

/**
 * Перебудовує alert_periods з alerts: тривога розрізається по київських добах (а отже, і по місяцях).
 * Рівень - останній відомий. Тривога без кінця лишається одним відкритим відрізком у добі початку.
 */
export const rebuildPeriods = async (c: Client, ids: number[]): Promise<void> => {
  if (!ids.length) return;
  await c.query('delete from alert_periods where alert_id = any($1)', [ids]);
  const sql = `
    insert into alert_periods (alert_id, day, month, region_uid, location_uid, level,
                               started_at, finished_at, duration_min)

    with
    -- Параметри запиту: далі в тексті лише params.*, без $1/$2/$3
    params as (
      select $1::int[] as ids,
             $2::text  as tz,
             $3::text  as alert_type
    ),

    -- Крок 1: по рядку на кожну київську добу, яку зачіпає тривога (day - київська північ, без зони).
    -- Остання доба - та, у якій тривога закінчилась (мінус 1 мкс: кінець рівно о 00:00 не дає порожнього шматка).
    alert_days as (
      select a.id as alert_id, a.region_uid, a.location_uid, a.level,
             a.started_at, a.finished_at, d.day
        from params
        join alerts a on a.id = any(params.ids)
       cross join lateral generate_series(
             date_trunc('day', a.started_at at time zone params.tz),
             date_trunc('day', coalesce(a.finished_at - interval '1 microsecond', a.started_at) at time zone params.tz),
             interval '1 day') as d(day)
       where a.alert_type = params.alert_type
         and (a.finished_at is null or a.finished_at > a.started_at)
    ),

    -- Крок 2: межі шматка в цій добі: s - початок, f - кінець (null, поки тривога триває)
    pieces as (
      select ad.alert_id, ad.region_uid, ad.location_uid, ad.level, ad.day,
             greatest(ad.started_at, ad.day at time zone params.tz) as s,
             case when ad.finished_at is null then null
                  else least(ad.finished_at, (ad.day + interval '1 day') at time zone params.tz)
             end as f
        from alert_days ad
       cross join params
    )

    -- Крок 3: у таблицю; month - перше число місяця доби, тривалість - хвилини з округленням
    select p.alert_id,
           p.day::date,
           date_trunc('month', p.day)::date,
           p.region_uid, p.location_uid, p.level,
           p.s, p.f,
           round(extract(epoch from (p.f - p.s)) / 60)::integer
      from pieces p`;
  await c.query(sql, [ids, config.timeZone, REPORT_ALERT_TYPE]);
};


export type RegionResult = ApplyStats & { region: number; warning?: string; error?: string };
export type RunResult = { runId: number; status: string; regions: RegionResult[]; staleClosed: number };

export class BusyError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Сам прогін: регіони -> БД, закриття завислих, підсумок у sync_runs. Наприкінці знімає advisory lock. */
const runSync = async (
  db: Db, fetcher: Fetcher, runId: number, lockClient: Client, pauseMs: number, now: () => Date,
): Promise<RunResult> => {
  const results: RegionResult[] = [];
  let staleClosed = 0;
  let fatal: string | null = null;
  try {
    const regions = (await db.query<{ uid: number }>('select uid from regions where enabled order by uid')).rows;
    for (let i = 0; i < regions.length; i++) {
      const uid = regions[i].uid;
      if (i > 0) await sleep(pauseMs);
      const r: RegionResult = { region: uid, fetched: 0, inserted: 0, updated: 0 };
      try {
        const prev = (await db.query<{ last: Date | null }>(
          'select max(last_seen_at) as last from alerts where region_uid = $1', [uid])).rows[0].last;
        const alerts = await fetcher(uid);
        const ts = now();
        Object.assign(r, await tx(db, async (c) => {
          const touched = new Set<number>();
          const s = await applyAlerts(c, uid, alerts, ts, touched);
          await rebuildPeriods(c, [...touched]);
          return s;
        }));
        if (prev && ts.getTime() - prev.getTime() > GAP_WARN_DAYS * 86_400_000) {
          r.warning = `previous sync ${prev.toISOString()} - possible gap in data`;
        }
      } catch (e) {
        r.error = (e as Error).message;
        log.error('region sync failed', { region: uid, error: r.error });
        if (e instanceof ApiError && e.fatal) fatal = r.error;
      }
      results.push(r);
      log.info('region synced', { ...r });
      if (fatal) break;
    }
    staleClosed = await tx(db, async (c) => {
      const touched = new Set<number>();
      const n = await closeStale(c, now(), touched);
      await rebuildPeriods(c, [...touched]);
      return n;
    });
    const failed = results.filter((r) => r.error).length;
    const status = failed === 0 ? 'ok' : failed === results.length ? 'error' : 'partial';
    await db.query(
      `update sync_runs set finished_at = now(), status = $2, details = $3, error = $4 where id = $1`,
      [runId, status, JSON.stringify({ regions: results, staleClosed }), fatal],
    );
    return { runId, status, regions: results, staleClosed };
  } catch (e) {
    const msg = (e as Error).message;
    await db.query(
      `update sync_runs set finished_at = now(), status = 'error', details = $2, error = $3 where id = $1`,
      [runId, JSON.stringify({ regions: results }), msg],
    ).catch(() => {});
    log.error('sync failed', { runId, error: msg });
    return { runId, status: 'error', regions: results, staleClosed };
  } finally {
    await lockClient.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
};

/**
 * Повний прогін: для кожного увімкненого регіону - історія з API -> БД.
 * Повертає runId одразу (`started`) і проміс з результатом (`done`).
 */
export const startSync = async (
  db: Db,
  fetcher: Fetcher,
  trigger: string,
  opts: { pauseMs?: number; now?: () => Date } = {},
): Promise<{ runId: number; done: Promise<RunResult> }> => {
  const pauseMs = opts.pauseMs ?? 31_000;
  const now = opts.now ?? (() => new Date());

  const lockClient = await db.connect();
  const got = (await lockClient.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEY])).rows[0].ok;
  if (!got) {
    lockClient.release();
    throw new BusyError('sync is already running');
  }
  let runId: number;
  try {
    runId = (await db.query('insert into sync_runs (trigger) values ($1) returning id', [trigger])).rows[0].id;
  } catch (e) {
    await lockClient.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
    throw e;
  }

  const done = runSync(db, fetcher, runId, lockClient, pauseMs, now);
  return { runId, done };
};
