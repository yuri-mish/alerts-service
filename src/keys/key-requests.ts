// Заявки на ключ API з лендінгу: перевірка, збереження в БД, повідомлення адміну в Telegram з кнопками
// «Прийняти» (створити ключ) / «Відмовити». Email поки не надсилається: адмін отримує готовий текст листа.
import type { Db } from '../core/db.ts';
import { log } from '../core/log.ts';
import { createKey } from './api-keys.ts';
import type { Telegram } from '../notify/telegram.ts';
import { config } from '../core/config.ts';
import { z } from 'zod';
import { isBotSubmission, optionalText, requiredText, validate } from '../core/validation.ts';

const SITE_URL = `${config.publicUrl}/`;

export type KeyRequest = { name: string; company: string | null; purpose: string; email: string };

type StoredRequest = KeyRequest & {
  id: number;
  status: 'pending' | 'approved' | 'rejected';
  telegram_message_id: number | null;
};

/** Мінімум полів оновлення Telegram, які ми обробляємо */
export type TelegramUpdate = {
  callback_query?: { id: string; from: { id: number }; data?: string };
};

export type Action = 'approve' | 'reject';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Поля форми заявки на лендінгу */
const keyRequestSchema = z.object({
  name: requiredText(100),
  company: optionalText(150),
  purpose: requiredText(1000),
  email: requiredText(200).regex(EMAIL_RE, 'invalid'),
});

/** Перевіряє форму (помилка -> ValidationError); бот (заповнена пастка `website`) -> 'bot' */
export const parseKeyRequest = (body: unknown): KeyRequest | 'bot' => {
  if (isBotSubmission(body)) return 'bot';
  return validate(keyRequestSchema, body);
};

// --- тексти повідомлень ---

const formatRequest = (request: StoredRequest): string => {
  const lines = [
    `🔑 Заявка на ключ API №${request.id}`,
    `Ім'я: ${request.name}`,
    `Компанія: ${request.company ?? '-'}`,
    `Email: ${request.email}`,
    `Для чого: ${request.purpose}`,
  ];
  return lines.join('\n');
};

const decisionButtons = (id: number) => [[
  { text: '✅ Прийняти', callback_data: `approve:${id}` },
  { text: '❌ Відмовити', callback_data: `reject:${id}` },
]];

const approvalLetter = (request: StoredRequest, key: string): string => {
  const lines = [
    `Кому: ${request.email}`,
    'Тема: Ключ API — історія повітряних тривог',
    '',
    `Вітаємо, ${request.name}!`,
    '',
    'Ваш ключ API:',
    key,
    '',
    `Передавайте його в заголовку X-Api-Key. Опис команд і приклади: ${SITE_URL}`,
    'Ліміт — 6 запитів на хвилину. Сервіс зараз працює безкоштовно в тестовому режимі.',
    'Не публікуйте ключ у відкритому коді сайтів.',
  ];
  return lines.join('\n');
};

const rejectionLetter = (request: StoredRequest): string => {
  const lines = [
    `Кому: ${request.email}`,
    'Тема: Заявка на ключ API — історія повітряних тривог',
    '',
    `Вітаємо, ${request.name}!`,
    '',
    'Дякуємо за інтерес до сервісу. На жаль, зараз ми не можемо надати ключ API за вашою заявкою.',
    `Якщо щось зміниться, ви можете подати нову заявку на ${SITE_URL}`,
  ];
  return lines.join('\n');
};

const kyivTime = (): string => {
  return new Date().toLocaleString('uk-UA', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' });
};

// --- подання заявки ---

/**
 * Зберігає заявку і надсилає її в Telegram з кнопками. Помилка Telegram не губить заявку:
 * вона лишається в БД з telegram_error. IP заявника не зберігається.
 */
export const submitKeyRequest = async (db: Db, telegram: Telegram | null, request: KeyRequest): Promise<number> => {
  const inserted = await db.query<StoredRequest>(
    `insert into key_requests (name, company, purpose, email)
     values ($1, $2, $3, $4)
     returning id, name, company, purpose, email, status, telegram_message_id`,
    [request.name, request.company, request.purpose, request.email],
  );
  const stored = inserted.rows[0];
  if (!telegram) {
    log.warn('key request saved, telegram is not configured', { id: stored.id });
    return stored.id;
  }
  try {
    const messageId = await telegram.api.sendMessage(telegram.chatId, formatRequest(stored), decisionButtons(stored.id));
    await db.query('update key_requests set telegram_sent = true, telegram_message_id = $2 where id = $1', [stored.id, messageId]);
  } catch (e) {
    const error = (e as Error).message;
    log.error('key request telegram failed', { id: stored.id, error });
    await db.query('update key_requests set telegram_error = $2 where id = $1', [stored.id, error]);
  }
  return stored.id;
};

// --- рішення адміна (вебхук Telegram) ---

const parseCallbackData = (data: string | undefined): { action: Action; id: number } | null => {
  const match = /^(approve|reject):(\d+)$/.exec(data ?? '');
  if (!match) return null;
  return { action: match[1] as Action, id: Number(match[2]) };
};

/** Атомарно забирає заявку зі стану pending; null - заявки немає або її вже оброблено */
const claimRequest = async (db: Db, id: number, status: 'approved' | 'rejected'): Promise<StoredRequest | null> => {
  const result = await db.query<StoredRequest>(
    `update key_requests set status = $2, decided_at = now()
      where id = $1 and status = 'pending'
      returning id, name, company, purpose, email, status, telegram_message_id`,
    [id, status],
  );
  return result.rows[0] ?? null;
};

const keyName = (request: StoredRequest): string => {
  const company = request.company ? ` / ${request.company}` : '';
  return `${request.name}${company} <${request.email}> (заявка №${request.id})`;
};

/** Дописує рішення в повідомлення із заявкою і прибирає кнопки */
const markDecided = async (telegram: Telegram, request: StoredRequest, line: string): Promise<void> => {
  if (!request.telegram_message_id) return;
  await telegram.api.editMessage(telegram.chatId, request.telegram_message_id, `${formatRequest(request)}\n\n${line}`);
};

export type Decision = {
  id: number;
  status: 'approved' | 'rejected';
  email: string;
  /** Створений ключ (лише для «Прийняти»); сам ключ більше ніде не зберігається */
  key: { id: number; value: string } | null;
  /** Готовий лист для пересилання на email */
  letter: string;
};

/**
 * Рішення по заявці (з Telegram або з адмінки). null - заявки немає або її вже оброблено.
 * Повідомлення із заявкою в Telegram оновлюється (кнопки зникають); помилка Telegram рішення не скасовує.
 */
export const decideKeyRequest = async (
  db: Db, telegram: Telegram | null, id: number, action: Action, source: 'telegram' | 'admin',
): Promise<Decision | null> => {
  const status = action === 'approve' ? 'approved' : 'rejected';
  const request = await claimRequest(db, id, status);
  if (!request) return null;

  let key: Decision['key'] = null;
  if (action === 'approve') {
    try {
      const created = await createKey(db, keyName(request));
      key = { id: created.id, value: created.key };
    } catch (e) {
      // ключ не створився - повертаємо заявку в очікування, щоб можна було спробувати ще раз
      await db.query(`update key_requests set status = 'pending', decided_at = null where id = $1`, [request.id]);
      throw e;
    }
    await db.query('update key_requests set api_key_id = $2 where id = $1', [request.id, key.id]);
  }

  if (telegram) {
    const via = source === 'admin' ? ' (в адмінці)' : '';
    const line = key ? `✅ Прийнято ${kyivTime()}${via}: ключ №${key.id}` : `❌ Відмовлено ${kyivTime()}${via}`;
    try {
      await markDecided(telegram, request, line);
    } catch (e) {
      log.error('telegram edit failed', { id: request.id, error: (e as Error).message });
    }
  }

  const letter = key ? approvalLetter(request, key.value) : rejectionLetter(request);
  return { id: request.id, status, email: request.email, key, letter };
};

/** Список заявок для адмінки: спершу ті, що чекають рішення */
export const listKeyRequests = async (db: Db) => {
  const result = await db.query(
    `select id, name, company, purpose, email, status, created_at, decided_at, api_key_id, telegram_sent
       from key_requests
      order by (status = 'pending') desc, id desc
      limit 500`,
  );
  return result.rows;
};

/** Обробляє натискання кнопок. Кнопки працюють лише для адміна (його chat_id = id користувача). */
export const handleTelegramUpdate = async (db: Db, telegram: Telegram, update: TelegramUpdate): Promise<void> => {
  const callback = update.callback_query;
  if (!callback) return;
  if (String(callback.from.id) !== telegram.chatId) {
    await telegram.api.answerCallback(callback.id, 'Немає прав');
    return;
  }
  const parsed = parseCallbackData(callback.data);
  if (!parsed) {
    await telegram.api.answerCallback(callback.id, 'Невідома дія');
    return;
  }
  const decision = await decideKeyRequest(db, telegram, parsed.id, parsed.action, 'telegram');
  if (!decision) {
    await telegram.api.answerCallback(callback.id, 'Заявку вже оброблено');
    return;
  }
  const title = decision.key
    ? `Лист для заявки №${decision.id} (перешліть на email):`
    : `Лист з відмовою для заявки №${decision.id} (перешліть на email):`;
  await telegram.api.sendMessage(telegram.chatId, `${title}\n\n${decision.letter}`);
  await telegram.api.answerCallback(callback.id, decision.key ? 'Ключ створено' : 'Відмовлено');
};
