// Спостерігач: повідомляє адміну в Telegram лише про проблеми (і про їх зникнення):
//  - прогін завершився з помилкою / частково / з попередженням;
//  - немає вдалого прогону понад STALE_AFTER_H годин (зокрема якщо прогін не запускався взагалі);
//  - найновішому бекапу (*.dump у теці бекапів) понад STALE_AFTER_H годин (зокрема якщо cron не спрацював).
// Заодно досилає повідомлення «Написати автору», які не дійшли через збій Telegram.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../core/db.ts';
import { log } from '../core/log.ts';
import { config } from '../core/config.ts';
import type { Telegram } from './telegram.ts';
import { resendContactMessages } from './contact.ts';

export type Send = (text: string) => Promise<void>;

const STALE_AFTER_H = 26; // щоденні задачі: доба + запас
const REMIND_EVERY_H = 12; // нагадування, поки проблема триває
const CHECK_EVERY_MS = 30 * 60_000; // раз на 30 хв (вимога користувача)
const HOUR_MS = 3_600_000;

type RunRow = {
  id: number;
  trigger: string;
  status: string;
  error: string | null;
  details: { regions?: { region: number; error?: string; warning?: string }[] } | null;
};

const formatTime = (date: Date): string => {
  return date.toLocaleString('uk-UA', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' });
};

const ageHours = (from: Date, now: Date): number => Math.round((now.getTime() - from.getTime()) / HOUR_MS);

/** Текст про проблемний прогін; null - прогін чистий */
const describeRun = (run: RunRow): string | null => {
  const regions = run.details?.regions ?? [];
  const failed = regions.filter((r) => r.error);
  const warned = regions.filter((r) => r.warning);
  if (run.status === 'ok' && warned.length === 0) return null;
  const icon = run.status === 'ok' ? '⚠️' : '❌';
  const lines = [`${icon} Прогін №${run.id} (${run.trigger}): ${run.status}`];
  if (run.error) lines.push(`Помилка: ${run.error}`);
  for (const r of failed.slice(0, 10)) lines.push(`Регіон ${r.region}: ${r.error}`);
  if (failed.length > 10) lines.push(`…і ще ${failed.length - 10} регіонів з помилками`);
  for (const r of warned.slice(0, 5)) lines.push(`Регіон ${r.region}: ${r.warning}`);
  return lines.join('\n');
};

/** Найновіший *.dump у теці; null - теки немає або вона порожня */
const newestBackup = (dir: string): { name: string; time: Date } | null => {
  let newest: { name: string; time: Date } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.dump')) continue;
    const time = statSync(join(dir, name)).mtime;
    if (!newest || time > newest.time) newest = { name, time };
  }
  return newest;
};

/** Стан однієї тривалої проблеми: перше повідомлення, нагадування, «відновлено» */
const createIncident = (send: Send, remindEveryMs: number) => {
  let since: Date | null = null;
  let lastSent = 0;
  return {
    problem: async (text: string, now: Date) => {
      if (!since) since = now;
      if (now.getTime() - lastSent < remindEveryMs) return;
      await send(text); // якщо Telegram недоступний - спробуємо на наступній перевірці
      lastSent = now.getTime();
    },
    resolved: async (text: string) => {
      if (!since) return;
      since = null;
      lastSent = 0;
      await send(text);
    },
  };
};

export type MonitorOptions = { backupDir: string | null; now?: () => Date };

export const createMonitor = (db: Db, send: Send, opts: MonitorOptions) => {
  const now = opts.now ?? (() => new Date());
  const remindMs = REMIND_EVERY_H * HOUR_MS;
  const staleMs = STALE_AFTER_H * HOUR_MS;
  const syncIncident = createIncident(send, remindMs);
  const backupIncident = createIncident(send, remindMs);
  let lastReportedRunId: number | null = null;

  /** Нові завершені прогони з проблемами (старі, що були до запуску сервісу, не повідомляємо) */
  const checkRuns = async () => {
    if (lastReportedRunId === null) {
      const max = await db.query<{ id: number | null }>(
        'select max(id) as id from sync_runs where finished_at is not null',
      );
      lastReportedRunId = max.rows[0].id ?? 0;
      return;
    }
    const runs = await db.query<RunRow>(
      `select id, trigger, status, error, details from sync_runs
        where id > $1 and finished_at is not null order by id`,
      [lastReportedRunId],
    );
    for (const run of runs.rows) {
      lastReportedRunId = run.id;
      const text = describeRun(run);
      if (text) await send(text);
    }
  };

  const checkSyncFreshness = async () => {
    const result = await db.query<{ id: number; finished_at: Date }>(
      `select id, finished_at from sync_runs where status in ('ok', 'partial') and finished_at is not null
        order by finished_at desc limit 1`,
    );
    const last = result.rows[0];
    const current = now();
    if (last && current.getTime() - last.finished_at.getTime() <= staleMs) {
      await syncIncident.resolved(
        `✅ Оновлення даних знову працює (прогін №${last.id}, ${formatTime(last.finished_at)})`,
      );
      return;
    }
    const when = last
      ? `останнє — ${formatTime(last.finished_at)}, ${ageHours(last.finished_at, current)} год тому`
      : 'ще не було жодного';
    await syncIncident.problem(
      `❌ Немає вдалого оновлення даних понад ${STALE_AFTER_H} год (${when}).\n` +
        'API віддає лише ~30 днів: якщо не виправити, дані за цей період буде втрачено.',
      current,
    );
  };

  const checkBackup = async () => {
    if (!opts.backupDir) return;
    const current = now();
    let newest: { name: string; time: Date } | null;
    try {
      newest = newestBackup(opts.backupDir);
    } catch (e) {
      newest = null;
      log.warn('backup dir is not readable', { dir: opts.backupDir, error: (e as Error).message });
    }
    if (newest && current.getTime() - newest.time.getTime() <= staleMs) {
      await backupIncident.resolved(`✅ Бекап бази знову є: ${newest.name}`);
      return;
    }
    const when = newest
      ? `останній — ${newest.name}, ${ageHours(newest.time, current)} год тому`
      : 'файлів бекапу не знайдено';
    await backupIncident.problem(
      `❌ Бекап бази не робився понад ${STALE_AFTER_H} год (${when}).\nПеревірте cron і ~/backups/alerts/backup.log`,
      current,
    );
  };

  /** Повідомлення «Написати автору», які раніше не дійшли через збій Telegram */
  const resendContacts = async () => {
    await resendContactMessages(db, send);
  };

  /** Одна перевірка; помилка однієї частини не зупиняє інші */
  const check = async () => {
    for (const step of [checkRuns, checkSyncFreshness, checkBackup, resendContacts]) {
      try {
        await step();
      } catch (e) {
        log.error('monitor check failed', { step: step.name, error: (e as Error).message });
      }
    }
  };

  const start = (): (() => void) => {
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  };

  return { check, start };
};

/**
 * Запускає спостерігача з повідомленнями в Telegram. Без Telegram - вимкнено.
 * Якщо теки бекапів немає (не змонтована) - свіжість бекапу не перевіряється.
 * Повертає функцію зупинки.
 */
export const startMonitor = (db: Db, telegram: Telegram | null, backupDir: string): (() => void) => {
  if (!telegram) return () => {};
  const dir = existsSync(backupDir) ? backupDir : null;
  if (!dir) log.warn('backup dir not mounted: backup freshness is not monitored', { dir: backupDir });
  const send = async (text: string) => {
    await telegram.api.sendMessage(telegram.chatId, text);
  };
  return createMonitor(db, send, { backupDir: dir }).start();
};
