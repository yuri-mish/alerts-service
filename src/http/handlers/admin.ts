// Маршрути керування (лише ключ адміністратора): ключі, заявки, оновлення даних, прогони, регіони.
import express, { type Request, type Response, type Router } from 'express';
import { createKey, deleteKey, KeyExistsError, listKeys, updateKey } from '../../keys/api-keys.ts';
import { decideKeyRequest, listKeyRequests, type Action } from '../../keys/key-requests.ts';
import { BusyError, startSync } from '../../sync/sync.ts';
import { z } from 'zod';
import { optionalText, requiredText } from '../../core/validation.ts';
import { HttpError, idParam, intField, parseBody, parseQuery, type Deps } from '../common.ts';

// --- тіла й параметри запитів ---

/** Новий ключ: name - кому видано; key - додати наявний ключ (без нього - згенерувати) */
const newKeyBody = z.object({
  name: requiredText(200),
  key: optionalText(200),
});

/** Зміна ключа: перейменувати і/або увімкнути/вимкнути */
const keyChangesBody = z.object({
  name: optionalText(200),
  enabled: z.boolean().nullish(),
});

const regionBody = z.object({
  title: optionalText(200),
  enabled: z.boolean().nullish(),
});

const syncQuery = z.object({ wait: z.string().optional() });
const runsQuery = z.object({ limit: intField.optional() });

export const createAdminRouter = ({ ctx, db, requireAdminKey }: Deps): Router => {
  // --- клієнтські ключі ---

  const getKeys = async (_req: Request, res: Response) => {
    res.json(await listKeys(db));
  };

  const postKey = async (req: Request, res: Response) => {
    const body = parseBody(newKeyBody, req);
    try {
      res.status(201).json(await createKey(db, body.name, body.key ?? undefined));
    } catch (e) {
      if (e instanceof KeyExistsError) throw new HttpError(409, e.message);
      throw new HttpError(400, (e as Error).message);
    }
  };

  const putKey = async (req: Request, res: Response) => {
    const body = parseBody(keyChangesBody, req);
    const changes = { name: body.name, enabled: body.enabled ?? null };
    const updated = await updateKey(db, idParam(req), changes);
    if (!updated) throw new HttpError(404, 'key not found');
    res.json(updated);
  };

  const removeKey = async (req: Request, res: Response) => {
    const deleted = await deleteKey(db, idParam(req));
    if (!deleted) throw new HttpError(404, 'key not found');
    res.json({ ok: true });
  };

  // --- заявки на ключ ---

  const getKeyRequests = async (_req: Request, res: Response) => {
    res.json(await listKeyRequests(db));
  };

  /** Обробник рішення по заявці: approve або reject */
  const decideBy = (action: Action) => async (req: Request, res: Response) => {
    const decision = await decideKeyRequest(db, ctx.telegram, idParam(req), action, 'admin');
    if (!decision) throw new HttpError(409, 'request not found or already decided');
    res.json(decision);
  };

  // --- оновлення даних і журнал прогонів ---

  const postSync = async (req: Request, res: Response) => {
    const q = parseQuery(syncQuery, req);
    try {
      const { runId, done } = await startSync(db, ctx.fetcher, 'http');
      if (q.wait === '1') return res.json(await done);
      done.catch(() => {});
      res.status(202).json({ runId, status: 'running', check: `/runs/${runId}` });
    } catch (e) {
      if (e instanceof BusyError) throw new HttpError(409, e.message);
      throw e;
    }
  };

  const getRuns = async (req: Request, res: Response) => {
    const q = parseQuery(runsQuery, req);
    const limit = Math.min(q.limit ?? 20, 200);
    const r = await db.query('select * from sync_runs order by id desc limit $1', [limit]);
    res.json(r.rows);
  };

  const getRun = async (req: Request, res: Response) => {
    const r = await db.query('select * from sync_runs where id = $1', [idParam(req)]);
    if (!r.rows[0]) throw new HttpError(404, 'run not found');
    res.json(r.rows[0]);
  };

  // --- регіони ---

  const getRegions = async (_req: Request, res: Response) => {
    const r = await db.query('select uid, title, enabled, created_at from regions order by uid');
    res.json(r.rows);
  };

  const putRegion = async (req: Request, res: Response) => {
    const body = parseBody(regionBody, req);
    const r = await db.query(
      `insert into regions (uid, title, enabled)
       values ($1::int, coalesce($2::text, 'UID ' || $1::int::text), coalesce($3::boolean, true))
       on conflict (uid) do update set title = coalesce($2::text, regions.title), enabled = coalesce($3::boolean, regions.enabled)
       returning uid, title, enabled`,
      [idParam(req), body.title, body.enabled ?? null],
    );
    res.json(r.rows[0]);
  };

  // усі маршрути цього роутера - лише з ключем адміністратора
  const router = express.Router();
  router.get('/keys',                       requireAdminKey, getKeys);
  router.post('/keys',                      requireAdminKey, postKey);
  router.put('/keys/:id',                   requireAdminKey, putKey);
  router.delete('/keys/:id',                requireAdminKey, removeKey);
  router.get('/key-requests',               requireAdminKey, getKeyRequests);
  router.post('/key-requests/:id/approve',  requireAdminKey, decideBy('approve'));
  router.post('/key-requests/:id/reject',   requireAdminKey, decideBy('reject'));
  router.post('/sync',                      requireAdminKey, postSync);
  router.get('/runs',                       requireAdminKey, getRuns);
  router.get('/runs/:id',                   requireAdminKey, getRun);
  router.get('/regions',                    requireAdminKey, getRegions);
  router.put('/regions/:id',                requireAdminKey, putRegion);
  return router;
};
