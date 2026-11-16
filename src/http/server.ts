// HTTP-сервер на Express: заголовки (CORS, безпека), розбір JSON, роутери, 404, обробка помилок.
// Маршрути - у handlers/: public (без ключа), data (клієнтський ключ), admin (ключ адміністратора).
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { log } from '../core/log.ts';
import { ValidationError } from '../core/validation.ts';
import { createFailureTracker, createRateLimiter } from '../keys/api-keys.ts';
import { createPublicStats } from '../site/stats.ts';
import { createKeyGuards } from './auth.ts';
import { HttpError, type Ctx, type Deps, type Limiters } from './common.ts';
import { createPublicRouter } from './handlers/public.ts';
import { createDataRouter } from './handlers/data.ts';
import { createAdminRouter } from './handlers/admin.ts';

// Заявки на ключ (форма лендінгу, без ключа): не більше 3 з одного IP на годину
const KEY_REQUESTS_PER_HOUR = 3;
// «Написати автору» (форма лендінгу, без ключа): не більше 5 повідомлень з одного IP на годину
const CONTACT_MESSAGES_PER_HOUR = 5;
// Підбір ключа: після 5 запитів з неправильним ключем IP блокується до кінця годинного вікна (вимога користувача)
const FAILED_AUTH_LIMIT = 5;
const FAILED_AUTH_WINDOW_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;

// CORS: GET-ендпоінти можна викликати з браузера з будь-якого сайту (ключ - у заголовку X-Api-Key)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Disposition, Retry-After',
};
const CORS_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Заголовки безпеки (helmet): стандартний набір (nosniff, HSTS, Cross-Origin-Opener-Policy тощо) з уточненнями:
// - сайт і адмінку не можна вбудувати в чужу сторінку (клікджекінг): X-Frame-Options DENY + CSP frame-ancestors;
//   решту CSP не вмикаємо - лендінг використовує вбудовані скрипти, Google Fonts і Google Tag Manager;
// - у Referer на інші сайти йде лише домен;
// - API відкрите для будь-якого сайту (CORS *), тож ресурси можна брати з інших доменів.
const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      // без default-src: обмежуємо лише вбудовування сторінки (повний CSP зламав би GTM і вбудовані скрипти)
      defaultSrc: helmet.contentSecurityPolicy.dangerouslyDisableDefaultSrc,
      frameAncestors: ["'none'"],
    },
  },
  xFrameOptions: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

/** CORS для всіх відповідей; OPTIONS (CORS preflight) - одразу 204 */
const corsHeaders = (req: Request, res: Response, next: NextFunction) => {
  res.set(CORS_HEADERS);
  if (req.method !== 'OPTIONS') return next();
  res.set(CORS_PREFLIGHT_HEADERS);
  res.status(204).end();
};

const notFound = (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
};

/** Код відповіді: наш HttpError, перевірка даних (400), помилки розбору тіла від Express (4xx), інше - 500 */
const errorStatus = (err: unknown): number => {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ValidationError) return 400;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) return status;
  return 500;
};

const errorMessage = (err: unknown, status: number): string => {
  if (status >= 500) return 'internal error';
  const type = (err as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return 'invalid JSON';
  if (type === 'entity.too.large') return 'body too large';
  return (err as Error).message;
};

// Обробник помилок Express розпізнає саме за чотирма параметрами
const handleError = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = errorStatus(err);
  if (status >= 500) log.error('http error', { path: req.path, error: (err as Error).message });
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: errorMessage(err, status) });
};

export const createApp = (ctx: Ctx): express.Express => {
  const limiters: Limiters = {
    perKey: createRateLimiter(ctx.rateLimitPerMin),
    keyRequestsPerIp: createRateLimiter(KEY_REQUESTS_PER_HOUR, HOUR_MS),
    contactPerIp: createRateLimiter(CONTACT_MESSAGES_PER_HOUR, HOUR_MS),
    failedAuth: createFailureTracker(FAILED_AUTH_LIMIT, FAILED_AUTH_WINDOW_MS),
  };
  const deps: Deps = {
    ctx,
    db: ctx.db,
    limiters,
    publicStats: createPublicStats(ctx.db),
    ...createKeyGuards(ctx, limiters),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(corsHeaders);
  // тіло - JSON незалежно від Content-Type (форми й тести можуть не ставити application/json)
  app.use(express.json({ limit: '100kb', type: () => true }));
  app.use(createPublicRouter(deps));
  app.use(createDataRouter(deps));
  app.use(createAdminRouter(deps));
  app.use(notFound);
  app.use(handleError);
  return app;
};

export const createServer = (ctx: Ctx): http.Server => http.createServer(createApp(ctx));
