// Розклад оновлення даних (croner): щодня о syncTime у зоні config.timeZone + догін після простою при старті.
import { Cron } from 'croner';
import type { Db } from '../core/db.ts';
import type { Fetcher } from './alerts-api.ts';
import { BusyError, startSync } from './sync.ts';
import { log } from '../core/log.ts';
import { config } from '../core/config.ts';

/** Після старту запускаємо прогін одразу, якщо вдалого не було стільки годин (сервіс простояв і пропустив розклад) */
const STARTUP_CATCH_UP_HOURS = 20;

/** 'HH:MM' -> cron-вираз «щодня о HH:MM»: '03:30' -> '30 3 * * *' */
const dailyCron = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
};

/** Прогін з журналом; паралельний прогін (BusyError - уже йде, напр. з /sync) не вважається помилкою */
const runSync = async (db: Db, fetcher: Fetcher, trigger: string): Promise<void> => {
  try {
    const { done } = await startSync(db, fetcher, trigger);
    const result = await done;
    log.info('scheduled sync finished', { trigger, runId: result.runId, status: result.status });
  } catch (e) {
    if (!(e instanceof BusyError)) log.error('scheduled sync failed', { trigger, error: (e as Error).message });
  }
};

/** Догін: якщо останній вдалий прогін старший за STARTUP_CATCH_UP_HOURS - запустити одразу (trigger 'startup') */
const catchUpOnStartup = async (db: Db, fetcher: Fetcher): Promise<void> => {
  const r = await db.query(
    `select 1 from sync_runs
      where status in ('ok', 'partial') and started_at > now() - make_interval(hours => $1)
      limit 1`,
    [STARTUP_CATCH_UP_HOURS],
  );
  if (!r.rowCount) await runSync(db, fetcher, 'startup');
};

/** Запускає розклад; повертає функцію зупинки */
export const startScheduler = (db: Db, fetcher: Fetcher, syncTime: string): (() => void) => {
  const job = new Cron(dailyCron(syncTime), { name: 'daily-sync', timezone: config.timeZone, protect: true }, () =>
    runSync(db, fetcher, 'schedule'),
  );
  log.info('scheduler started', { syncTime, timeZone: config.timeZone, nextRun: job.nextRun()?.toISOString() });
  catchUpOnStartup(db, fetcher).catch((e) => log.error('startup sync failed', { error: (e as Error).message }));
  return () => job.stop();
};
