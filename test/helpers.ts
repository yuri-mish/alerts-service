// Спільне для тестів з базою: окрема схема Postgres на кожен файл тестів (створюється і видаляється),
// фейковий API alerts.in.ua, фейковий Telegram, допоміжні конструктори.
// Підключення цього модуля реєструє before/after для файлу тестів, що його імпортує.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPool, type Db } from '../src/core/db.ts';
import { migrate } from '../src/migrate.ts';
import { startSync } from '../src/sync/sync.ts';
import { config } from '../src/core/config.ts';
import type { ApiAlert } from '../src/sync/alerts-api.ts';
import type { InlineButton, Telegram, TelegramApi } from '../src/notify/telegram.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for tests');
const schema = `alerts_test_${process.pid}`;

/** Підключення до тестової схеми (з'являється в before) */
export let db: Db;

before(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  db = createPool(url, schema);
  await migrate(db);
});

after(async () => {
  await db.end();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

/** Тривога з типовими полями (м. Київ, повітряна, жовта, триває) */
export const A = (p: Partial<ApiAlert> & { id: number }): ApiAlert => ({
  locationUid: 31,
  locationTitle: 'м. Київ',
  locationType: 'city',
  alertType: 'air_raid',
  level: 'yellow',
  startedAt: new Date(),
  finishedAt: null,
  updatedAt: null,
  ...p,
});
export const D = (s: string) => new Date(s);

/** Фейковий API: відповідь для кожного регіону задається в `fakeApi.responses` */
export const fakeApi: { responses: Record<number, ApiAlert[]> } = { responses: {} };
export const fetcher = async (uid: number) => fakeApi.responses[uid] ?? [];

/** Прогін синхронізації з фейковим API; очікує статус ok */
export const sync = async (now?: Date) => {
  const { done } = await startSync(db, fetcher, 'test', { pauseMs: 0, now: now ? () => now : undefined });
  const r = await done;
  assert.equal(r.status, 'ok', JSON.stringify(r));
  return r;
};

/** Відрізки тривоги по добах (час - у зоні сервісу) */
export const periods = async (id: number) =>
  (
    await db.query(
      `select level, to_char(month, 'YYYY-MM') as month, to_char(day, 'YYYY-MM-DD') as day, duration_min,
            to_char(started_at at time zone $2::text, 'YYYY-MM-DD HH24:MI') as s,
            to_char(finished_at at time zone $2::text, 'YYYY-MM-DD HH24:MI') as f
       from alert_periods where alert_id = $1 order by day`,
      [id, config.timeZone],
    )
  ).rows;

/** Фейковий Telegram: запам'ятовує надіслані/змінені повідомлення і відповіді на кнопки */
export const ADMIN_CHAT = 4242;
export const fakeTelegram = () => {
  const sent: { text: string; buttons?: InlineButton[][]; messageId: number }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  const answers: string[] = [];
  let failing = false;
  let nextMessageId = 100;
  const api: TelegramApi = {
    sendMessage: async (_chatId, text, buttons) => {
      if (failing) throw new Error('Telegram 500: test');
      const messageId = nextMessageId++;
      sent.push({ text, buttons, messageId });
      return messageId;
    },
    editMessage: async (_chatId, messageId, text) => {
      edits.push({ messageId, text });
    },
    answerCallback: async (_id, text) => {
      answers.push(text);
    },
    setWebhook: async () => {},
  };
  const telegram: Telegram = { api, chatId: String(ADMIN_CHAT), webhookSecret: 'test-webhook-secret' };
  return {
    telegram,
    sent,
    edits,
    answers,
    fail: (value: boolean) => {
      failing = value;
    },
  };
};
