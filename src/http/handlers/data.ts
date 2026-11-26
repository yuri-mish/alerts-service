// Маршрути даних про тривоги (клієнтський ключ): /periods, /summary, /1c/alerts, /alerts/:id.
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  HttpError,
  idParam,
  intField,
  intListField,
  levelField,
  LOCAL,
  LOCAL_ISO,
  monthField,
  parseQuery,
  sendCsv,
  type Deps,
} from '../common.ts';

// --- параметри запитів ---

// Обов'язковий лише month (вимога користувача, 26.11.2026): обсяг відповіді - один місяць.
// Без region і location - усі області.
// Схеми рядка запиту - суворі (z.strictObject): невідомий параметр (опечатка `levle=`, непідтримуваний фільтр) -> 400,
// а не мовчки ігнорується (вимога користувача, 16.11.2026).

export const periodsQuery = z.strictObject({
  month: monthField,
  region: intListField.optional(),
  location: intListField.optional(),
  level: levelField.optional(),
  limit: intField.optional(),
  format: z.string().optional(),
});

export const oneCQuery = z.strictObject({
  month: monthField,
  region: intListField.optional(),
  location: intListField.optional(),
  level: levelField.optional(),
  format: z.string().optional(),
});

export const summaryQuery = z.strictObject({
  month: monthField,
  region: intListField.optional(),
  location: intListField.optional(),
  by: z.string().optional(),
});

/** 'YYYY-MM-01' -> 'YYYY-MM' для імені CSV-файлу */
const monthLabel = (firstDay: string): string => firstDay.slice(0, 7);

export const createDataRouter = ({ db, requireClientKey }: Deps): Router => {
  const getPeriods = async (req: Request, res: Response) => {
    const q = parseQuery(periodsQuery, req);
    const limit = Math.min(q.limit ?? 50_000, 200_000);
    const r = await db.query(
      `select ap.region_uid, ap.location_uid, a.location_title, a.location_type,
              ap.level, to_char(ap.month, 'YYYY-MM') as month, to_char(ap.day, 'YYYY-MM-DD') as day,
              ${LOCAL('ap.started_at')} as started_local, ${LOCAL('ap.finished_at')} as finished_local,
              ap.duration_min, ap.alert_id, a.closed_by,
              ap.started_at, ap.finished_at
         from alert_periods ap join alerts a on a.id = ap.alert_id
        where ap.month = $1
          and ($2::int[] is null or ap.region_uid = any($2))
          and ($3::int[] is null or ap.location_uid = any($3))
          and ($4::text is null or ap.level = $4)
        order by date_trunc('second', ap.started_at), ap.location_uid, ap.alert_id
        limit $5`,
      [q.month, q.region ?? null, q.location ?? null, q.level ?? null, limit],
    );
    if (q.format === 'csv') {
      const rows = r.rows.map(({ started_at, finished_at, ...rest }) => rest);
      return sendCsv(res, `alerts-${monthLabel(q.month)}.csv`, rows);
    }
    res.json(r.rows);
  };

  /**
   * Вигрузка для 1С: тривога розрізана по київських добах, один рядок на добу.
   * Початок/кінець шматка, що перетнув опівніч, - 00:00:00 відповідної доби (кінець попередньої = 00:00:00 наступної).
   * НомерТревоги рахується по всіх тривогах території й доби, а фільтр level накладається після нумерації:
   * інакше окремі вигрузки жовтих і червоних дали б два «№1» в одній добі (конфлікт ключа в 1С).
   */
  const getOneCAlerts = async (req: Request, res: Response) => {
    const q = parseQuery(oneCQuery, req);
    const r = await db.query(
      `with numbered as (
         select ap.*,
                (row_number() over (partition by ap.location_uid, ap.day order by ap.started_at, ap.alert_id))::int as alert_no
           from alert_periods ap
          where ap.month = $1
            and ($2::int[] is null or ap.region_uid = any($2))
            and ($3::int[] is null or ap.location_uid = any($3))
       )
       select to_char(n.month, 'YYYY-MM-DD"T"HH24:MI:SS') as "ПериодМесяц",
              extract(day from n.day)::int as "ДеньМесяца",
              n.location_uid as "КодТеритории",
              'Тревога' as "ТипСобытия",
              n.alert_no as "НомерТревоги",
              ${LOCAL_ISO('n.started_at')} as "Начало",
              ${LOCAL_ISO('n.finished_at')} as "Конец"
         from numbered n
        where ($4::text is null or n.level = $4)
        order by date_trunc('second', n.started_at), n.location_uid, n.alert_id`,
      [q.month, q.region ?? null, q.location ?? null, q.level ?? null],
    );
    if (q.format === 'csv') return sendCsv(res, `alerts-1c-${monthLabel(q.month)}.csv`, r.rows);
    res.json(r.rows);
  };

  const getSummary = async (req: Request, res: Response) => {
    const q = parseQuery(summaryQuery, req);
    const byLocation = q.by === 'location';
    const key = byLocation ? 'ap.region_uid, ap.location_uid' : 'ap.region_uid';
    // hours = об'єднання інтервалів (тривоги в районах/громадах перекриваються).
    // Активна тривога (без кінця) рахується до поточного моменту: з відкритим кінцем об'єднаний діапазон
    // став би необмеженим, і вся його тривалість випала б із годин.
    const r = await db.query(
      `select ap.region_uid, ${byLocation ? 'ap.location_uid, min(a.location_title) as location_title,' : ''}
              coalesce(ap.level, case when grouping(ap.level) = 1 then 'all' else 'unknown' end) as level,
              count(distinct ap.alert_id)::int as alerts,
              round((select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0)
                       from unnest(range_agg(tstzrange(ap.started_at, coalesce(ap.finished_at, greatest(now(), ap.started_at))))) as x) / 3600, 2) as hours,
              count(*) filter (where ap.finished_at is null)::int as still_active
         from alert_periods ap join alerts a on a.id = ap.alert_id
        where ap.month = $1
          and ($2::int[] is null or ap.region_uid = any($2))
          and ($3::int[] is null or ap.location_uid = any($3))
        group by grouping sets ((${key}, ap.level), (${key}))
        order by ${key}, level`,
      [q.month, q.region ?? null, q.location ?? null],
    );
    res.json(r.rows);
  };

  const getAlert = async (req: Request, res: Response) => {
    const id = idParam(req);
    const alert = (await db.query('select * from alerts where id = $1', [id])).rows[0];
    if (!alert) throw new HttpError(404, 'alert not found');
    const periods = (await db.query('select * from alert_periods where alert_id = $1 order by day', [id])).rows;
    res.json({ ...alert, periods });
  };

  // prettier-ignore
  return express.Router()
    .get('/periods',    requireClientKey, getPeriods)
    .get('/summary',    requireClientKey, getSummary)
    .get('/1c/alerts',  requireClientKey, getOneCAlerts)
    .get('/alerts/:id', requireClientKey, getAlert);
};
