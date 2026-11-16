// Маршрути даних про тривоги (клієнтський ключ): /periods, /summary, /1c/alerts, /alerts/:id.
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  HttpError, idParam, intField, intListField, levelField, LOCAL, LOCAL_ISO, monthField, parseQuery, sendCsv, type Deps,
} from '../common.ts';

// --- параметри запитів ---

const periodsQuery = z
  .object({
    month: monthField.optional(),
    region: intListField.optional(),
    location: intListField.optional(),
    level: levelField.optional(),
    limit: intField.optional(),
    format: z.string().optional(),
  })
  .refine((q) => q.month || q.region || q.location, 'specify at least month, region or location');

const oneCQuery = z.object({
  month: monthField,
  region: intListField.optional(),
  location: intListField.optional(),
  format: z.string().optional(),
});

const summaryQuery = z.object({
  month: monthField,
  region: intListField.optional(),
  location: intListField.optional(),
  by: z.string().optional(),
});

/** 'YYYY-MM-01' -> 'YYYY-MM' для імені CSV-файлу */
const monthLabel = (firstDay: string | undefined): string => firstDay?.slice(0, 7) ?? 'all';

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
        where ($1::date is null or ap.month = $1)
          and ($2::int[] is null or ap.region_uid = any($2))
          and ($3::int[] is null or ap.location_uid = any($3))
          and ($4::text is null or ap.level = $4)
        order by date_trunc('second', ap.started_at), ap.location_uid, ap.alert_id
        limit $5`,
      [q.month ?? null, q.region ?? null, q.location ?? null, q.level ?? null, limit],
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
   */
  const getOneCAlerts = async (req: Request, res: Response) => {
    const q = parseQuery(oneCQuery, req);
    const r = await db.query(
      `select to_char(ap.month, 'YYYY-MM-DD"T"HH24:MI:SS') as "ПериодМесяц",
              extract(day from ap.day)::int as "ДеньМесяца",
              ap.location_uid as "КодТеритории",
              'Тревога' as "ТипСобытия",
              (row_number() over (partition by ap.location_uid, ap.day order by ap.started_at, ap.alert_id))::int as "НомерТревоги",
              ${LOCAL_ISO('ap.started_at')} as "Начало",
              ${LOCAL_ISO('ap.finished_at')} as "Конец"
         from alert_periods ap
        where ap.month = $1
          and ($2::int[] is null or ap.region_uid = any($2))
          and ($3::int[] is null or ap.location_uid = any($3))
        order by date_trunc('second', ap.started_at), ap.location_uid, ap.alert_id`,
      [q.month, q.region ?? null, q.location ?? null],
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

  const router = express.Router();
  router.get('/periods',    requireClientKey, getPeriods);
  router.get('/summary',    requireClientKey, getSummary);
  router.get('/1c/alerts',  requireClientKey, getOneCAlerts);
  router.get('/alerts/:id', requireClientKey, getAlert);
  return router;
};
