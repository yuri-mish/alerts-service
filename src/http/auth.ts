// Перевірка ключа X-Api-Key як middleware Express:
//   router.get('/periods', requireClientKey, getPeriods)  - клієнтський ключ (з лімітом) або ключ адміністратора
//   router.get('/keys', requireAdminKey, getKeys)         - лише ключ адміністратора
import type { Request, RequestHandler, Response } from 'express';
import { findClientKey } from '../keys/api-keys.ts';
import { clientIp, enforceLimit, HttpError, sameKey, type Ctx, type Limiters } from './common.ts';

type Auth = { role: 'admin' } | { role: 'client'; keyId: number };

export type KeyGuards = { requireClientKey: RequestHandler; requireAdminKey: RequestHandler };

export const createKeyGuards = (ctx: Ctx, limiters: Limiters): KeyGuards => {
  /** Чий ключ у запиті: адміна (env API_KEY), клієнта (таблиця api_keys) або нічий (null) */
  const findOwner = async (key: string): Promise<Auth | null> => {
    if (sameKey(key, ctx.adminKey)) return { role: 'admin' };
    const clientKey = await findClientKey(ctx.db, key);
    if (!clientKey) return null;
    return { role: 'client', keyId: clientKey.id };
  };

  /**
   * Хто звертається; без дійсного ключа - 401.
   * Захист від підбору: IP з багатьма невдалими ключами блокується (навіть з правильним ключем);
   * запит без ключа спробою підбору не вважається.
   */
  const identify = async (req: Request, res: Response): Promise<Auth> => {
    const ip = clientIp(req);
    enforceLimit(res, limiters.failedAuth.blockedFor(ip), 'too many invalid keys');
    const key = String(req.headers['x-api-key'] ?? '');
    if (!key) throw new HttpError(401, 'X-Api-Key required');
    const auth = await findOwner(key);
    if (!auth) {
      limiters.failedAuth.recordFailure(ip);
      throw new HttpError(401, 'X-Api-Key required');
    }
    return auth;
  };

  /** Клієнтський ключ - не частіше за ліміт на хвилину; адміну ліміт не діє */
  const requireClientKey: RequestHandler = async (req, res, next) => {
    const auth = await identify(req, res);
    if (auth.role === 'client') enforceLimit(res, limiters.perKey(auth.keyId), 'rate limit exceeded');
    next();
  };

  const requireAdminKey: RequestHandler = async (req, res, next) => {
    const auth = await identify(req, res);
    if (auth.role !== 'admin') throw new HttpError(403, 'admin key required');
    next();
  };

  return { requireClientKey, requireAdminKey };
};
