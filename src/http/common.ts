// Спільне для HTTP-сервера й роутерів: типи, помилка з кодом, CSV, поля й розбір параметрів запиту (zod).
import type { Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../core/db.ts';
import { z } from 'zod';
import { LEVELS, type Fetcher } from '../sync/alerts-api.ts';
import { config } from '../core/config.ts';
import { validate } from '../core/validation.ts';
import type { createFailureTracker, createRateLimiter } from '../keys/api-keys.ts';
import type { Telegram } from '../notify/telegram.ts';
import type { createPublicStats } from '../site/stats.ts';

/**
 * adminKey - env API_KEY (усі ендпоінти); клієнтські ключі - таблиця api_keys (лише читання даних).
 * telegram - куди слати заявки на ключ і звідки приймати рішення по них; null - лише зберігати в БД.
 */
export type Ctx = { db: Db; fetcher: Fetcher; adminKey: string; rateLimitPerMin: number; telegram: Telegram | null };
export type Limiter = ReturnType<typeof createRateLimiter>;
export type Limiters = {
  perKey: Limiter;
  keyRequestsPerIp: Limiter;
  contactPerIp: Limiter;
  failedAuth: ReturnType<typeof createFailureTracker>;
};
export type PublicStatsFn = ReturnType<typeof createPublicStats>;

/** Залежності роутерів; requireClientKey / requireAdminKey - middleware перевірки ключа (auth.ts) */
export type Deps = {
  ctx: Ctx;
  db: Db;
  limiters: Limiters;
  publicStats: PublicStatsFn;
  requireClientKey: RequestHandler;
  requireAdminKey: RequestHandler;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** CSV для Excel: «;», десяткова кома, BOM (щоб Excel побачив UTF-8) */
export const sendCsv = (res: Response, name: string, rows: Record<string, unknown>[]): void => {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))];
  res.attachment(name);
  res.type('text/csv; charset=utf-8');
  res.send('﻿' + lines.join('\r\n'));
};

/** Тіло запиту як об'єкт (порожнє або не об'єкт -> {}) */
export const jsonBody = (req: Request): Record<string, unknown> => {
  const body: unknown = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
};

/** Порівняння ключів за сталий час (не підказує, скільки символів збіглося) */
export const sameKey = (got: string, key: string): boolean => {
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Ліміт вичерпано (retryAfterSec > 0) -> 429 із заголовком Retry-After */
export const enforceLimit = (res: Response, retryAfterSec: number, message: string): void => {
  if (retryAfterSec <= 0) return;
  res.set('Retry-After', String(retryAfterSec));
  throw new HttpError(429, `${message}, retry in ${retryAfterSec}s`);
};

/** IP клієнта: nginx кладе його в X-Real-IP (сервіс слухає лише 127.0.0.1, тож заголовок ставить тільки nginx) */
export const clientIp = (req: Request): string => {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return realIp;
  return req.socket.remoteAddress ?? 'unknown';
};

/** Числовий параметр шляху (:id); не число -> 404, як для неіснуючої адреси */
export const idParam = (req: Request, name = 'id'): number => {
  const v = req.params[name];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new HttpError(404, 'not found');
  return Number(v);
};

// --- поля рядка запиту (?month=2026-11&region=14,31) для схем zod ---

/** Місяць YYYY-MM -> перший день місяця 'YYYY-MM-01' (для SQL) */
export const monthField = z
  .string({ error: 'required (YYYY-MM)' })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
  .transform((month) => `${month}-01`);

/** Невід'ємне ціле */
export const intField = z.string().regex(/^\d+$/, 'must be an integer').transform(Number);

/** Список цілих через кому: `14,31` -> [14, 31] (без повторів, не більше 200) */
export const intListField = z
  .string()
  .regex(/^\d+(\s*,\s*\d+)*$/, 'must be integers separated by commas')
  .transform((list) => [...new Set(list.split(',').map((item) => Number(item.trim())))])
  .refine((ids) => ids.length <= 200, 'too many values (max 200)');

export const levelField = z.enum(LEVELS, { error: `must be ${LEVELS.join(' or ')}` });

/** Рядок запиту за схемою; порожні значення (`?region=`) вважаються відсутніми */
export const parseQuery = <Schema extends z.ZodType>(schema: Schema, req: Request): z.output<Schema> => {
  const filled = Object.entries(req.query).filter(([, value]) => value !== '');
  return validate(schema, Object.fromEntries(filled));
};

/** Тіло запиту (JSON) за схемою; без тіла - як порожній об'єкт */
export const parseBody = <Schema extends z.ZodType>(schema: Schema, req: Request): z.output<Schema> =>
  validate(schema, req.body ?? {});

/** Київський час у форматі ISO без зони: 2026-11-10T12:00:00 (null лишається null) */
export const LOCAL_ISO = (col: string) =>
  `to_char(${col} at time zone '${config.timeZone}', 'YYYY-MM-DD"T"HH24:MI:SS')`;
/** Той самий час з пробілом замість T - для людей і Excel: 2026-11-10 12:00:00 */
export const LOCAL = (col: string) => `to_char(${col} at time zone '${config.timeZone}', 'YYYY-MM-DD HH24:MI:SS')`;
