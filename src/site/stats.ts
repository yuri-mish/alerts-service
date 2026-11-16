// Публічна статистика для графіка на лендінгу (без ключа): лише агрегат по регіонах, без сирих даних.
// Рахується з кешем, щоб відвідувачі сторінки не навантажували базу.
import type { Db } from '../core/db.ts';
import { config } from '../core/config.ts';

export type RegionStats = { uid: number; title: string; hours: number; red_hours: number; alerts: number };
export type PublicStats = { from: string; to: string; days: number; updated_at: string; regions: RegionStats[] };

const DAYS = 30;
const CACHE_MS = 10 * 60_000;

/**
 * Години тривог по кожному регіону за останні DAYS днів (включно з сьогодні, київські доби).
 * Години - «хоч десь в області»: об'єднання інтервалів усіх територій регіону (не сума і не середнє);
 * активна тривога рахується до поточного моменту. alerts - кількість тривог усіх територій (з перекриттями).
 */
const queryStats = async (db: Db): Promise<PublicStats> => {
  const sql = `
    with
    params as (
      select $1::text as tz, $2::int as days
    ),
    -- вікно: останні days київських діб, включно з сьогодні
    win as (
      select (now() at time zone params.tz)::date - (params.days - 1) as from_day,
             (now() at time zone params.tz)::date as to_day
        from params
    ),
    -- інтервал кожного відрізка; активна тривога - до поточного моменту
    pieces as (
      select ap.region_uid, ap.alert_id, ap.level,
             tstzrange(ap.started_at, coalesce(ap.finished_at, greatest(now(), ap.started_at))) as span
        from alert_periods ap, win
       where ap.day between win.from_day and win.to_day
    ),
    per_region as (
      select region_uid,
             count(distinct alert_id)::int as alerts,
             range_agg(span) as all_spans,
             range_agg(span) filter (where level = 'red') as red_spans
        from pieces
       group by region_uid
    )
    select r.uid, r.title,
           coalesce(pr.alerts, 0) as alerts,
           round(coalesce((select sum(extract(epoch from upper(x) - lower(x))) from unnest(pr.all_spans) as x), 0) / 3600, 1)::float8 as hours,
           round(coalesce((select sum(extract(epoch from upper(x) - lower(x))) from unnest(pr.red_spans) as x), 0) / 3600, 1)::float8 as red_hours,
           to_char(win.from_day, 'YYYY-MM-DD') as from_day,
           to_char(win.to_day, 'YYYY-MM-DD') as to_day
      from regions r
      cross join win
      left join per_region pr on pr.region_uid = r.uid
     where r.enabled
     order by hours desc, r.title`;
  const result = await db.query(sql, [config.timeZone, DAYS]);
  const first = result.rows[0];
  const regions = result.rows.map((row) => ({
    uid: row.uid, title: row.title, hours: row.hours, red_hours: row.red_hours, alerts: row.alerts,
  }));
  return {
    from: first?.from_day ?? '',
    to: first?.to_day ?? '',
    days: DAYS,
    updated_at: new Date().toISOString(),
    regions,
  };
};

/** Статистика з кешем на CACHE_MS; паралельні запити під час перерахунку чекають один і той самий результат */
export const createPublicStats = (db: Db) => {
  let cached: { at: number; value: Promise<PublicStats> } | null = null;
  return async (now = Date.now()): Promise<PublicStats> => {
    if (!cached || now - cached.at > CACHE_MS) {
      const value = queryStats(db);
      cached = { at: now, value };
      value.catch(() => { cached = null; }); // помилку не кешуємо
    }
    return cached.value;
  };
};
