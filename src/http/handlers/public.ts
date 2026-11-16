// Маршрути без ключа: сторінки сайту, статистика для графіка, форми лендінгу, вебхук Telegram.
import express, { type Request, type Response, type Router } from 'express';
import { config } from '../../core/config.ts';
import { log } from '../../core/log.ts';
import { createSitePages, type StaticPage } from '../../site/site.ts';
import { handleTelegramUpdate, parseKeyRequest, submitKeyRequest, type TelegramUpdate } from '../../keys/key-requests.ts';
import { parseContactMessage, submitContactMessage } from '../../notify/contact.ts';
import { clientIp, enforceLimit, HttpError, jsonBody, sameKey, type Deps } from '../common.ts';

export const createPublicRouter = ({ ctx, db, limiters, publicStats }: Deps): Router => {
  /** Статична сторінка; на HEAD Express сам не надсилає тіло (для пошукових роботів) */
  const sendPage = (page: StaticPage) => (_req: Request, res: Response) => {
    res.set({ 'Content-Type': page.contentType, 'Cache-Control': page.cacheControl, ...page.headers });
    res.send(page.body);
  };

  /** Агрегат для графіка на лендінгу (кеш 10 хв) */
  const getStats = async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.json(await publicStats());
  };

  const getHealth = async (_req: Request, res: Response) => {
    const r = await db.query(`select id, status, started_at, finished_at from sync_runs order by id desc limit 1`);
    res.json({ ok: true, lastRun: r.rows[0] ?? null });
  };

  /** Заявка на ключ з лендінгу; неправильні поля -> 400 (ValidationError) */
  const postKeyRequest = async (req: Request, res: Response) => {
    enforceLimit(res, limiters.keyRequestsPerIp(clientIp(req)), 'too many requests');
    const request = parseKeyRequest(req.body);
    // бот заповнив приховане поле - відповідаємо як успіх, але нічого не робимо
    if (request !== 'bot') await submitKeyRequest(db, ctx.telegram, request);
    res.status(201).json({ ok: true });
  };

  /** «Написати автору» з лендінгу; неправильні поля -> 400 (ValidationError) */
  const postContact = async (req: Request, res: Response) => {
    enforceLimit(res, limiters.contactPerIp(clientIp(req)), 'too many messages');
    const contactMessage = parseContactMessage(req.body);
    // бот заповнив приховане поле - відповідаємо як успіх, але нічого не робимо
    if (contactMessage !== 'bot') await submitContactMessage(db, ctx.telegram, contactMessage);
    res.status(201).json({ ok: true });
  };

  /** Вебхук Telegram: кнопки «Прийняти» / «Відмовити» (перевірка секрету замість X-Api-Key) */
  const postTelegramWebhook = async (req: Request, res: Response) => {
    if (!ctx.telegram) throw new HttpError(404, 'not found');
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (!sameKey(secret, ctx.telegram.webhookSecret)) throw new HttpError(401, 'invalid secret');
    const update = jsonBody(req) as TelegramUpdate;
    // Telegram повторює запит, доки не отримає 200, тому помилку лише логуємо
    try {
      await handleTelegramUpdate(db, ctx.telegram, update);
    } catch (e) {
      log.error('telegram update failed', { error: (e as Error).message });
    }
    res.json({ ok: true });
  };

  const router = express.Router();
  // лендінг, robots.txt, sitemap.xml, іконка, адмінка (дані адмінки - лише з ключем)
  for (const [path, page] of createSitePages(config.publicUrl)) router.get(path, sendPage(page));
  router.get('/stats', getStats);
  router.get('/health', getHealth);
  router.post('/key-requests', postKeyRequest);
  router.post('/contact', postContact);
  router.post('/telegram/webhook', postTelegramWebhook);
  return router;
};
