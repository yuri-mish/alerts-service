// Мінімальний клієнт Telegram Bot API (лише те, що потрібно для заявок на ключ). Без parse_mode:
// текст, введений користувачем, не може зламати розмітку.
import { createHash } from 'node:crypto';
import { log } from '../core/log.ts';

export type InlineButton = { text: string; callback_data: string };

export type TelegramApi = {
  /** Повертає message_id надісланого повідомлення */
  sendMessage: (chatId: string, text: string, buttons?: InlineButton[][]) => Promise<number>;
  /** Замінює текст повідомлення і прибирає кнопки */
  editMessage: (chatId: string, messageId: number, text: string) => Promise<void>;
  /** Коротка спливна відповідь на натискання кнопки */
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  setWebhook: (url: string, secret: string) => Promise<void>;
};

/** Налаштований Telegram: клієнт, чат адміна (лише він може натискати кнопки), секрет вебхука */
export type Telegram = { api: TelegramApi; chatId: string; webhookSecret: string };

const TIMEOUT_MS = 10_000;

export const createTelegramApi = (botToken: string): TelegramApi => {
  const call = async (method: string, payload: object): Promise<unknown> => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json() as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method} ${response.status}: ${body.description ?? 'unknown error'}`);
    return body.result;
  };

  return {
    sendMessage: async (chatId, text, buttons) => {
      const payload = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
      };
      const message = await call('sendMessage', payload) as { message_id: number };
      return message.message_id;
    },
    editMessage: async (chatId, messageId, text) => {
      await call('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true });
    },
    answerCallback: async (callbackQueryId, text) => {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    },
    setWebhook: async (url, secret) => {
      await call('setWebhook', { url, secret_token: secret, allowed_updates: ['callback_query'] });
    },
  };
};

/**
 * Секрет вебхука: Telegram надсилає його в заголовку X-Telegram-Bot-Api-Secret-Token.
 * Виводиться з токена бота, щоб не заводити ще одну змінну в .env.
 */
export const deriveWebhookSecret = (botToken: string): string => {
  return createHash('sha256').update(`alerts-webhook:${botToken}`).digest('hex');
};

export type TelegramSettings = { botToken: string; chatId: string; publicUrl: string };

/** Паузи між повторними спробами зареєструвати вебхук: 1, 2, 5, 10 хв, далі кожні 30 хв */
const WEBHOOK_RETRY_DELAYS_MS = [1, 2, 5, 10, 30].map((minutes) => minutes * 60_000);

/**
 * Реєструє вебхук; якщо Telegram недоступний - повторює у фоні, доки не вдасться
 * (інакше кнопки «Прийняти»/«Відмовити» не працювали б до перезапуску сервісу).
 * Повертає true, якщо вдалося з першої спроби.
 */
export const registerWebhook = async (
  api: TelegramApi, url: string, secret: string, delaysMs = WEBHOOK_RETRY_DELAYS_MS, attempt = 0,
): Promise<boolean> => {
  try {
    await api.setWebhook(url, secret);
    log.info('telegram webhook set', { url, attempt: attempt + 1 });
    return true;
  } catch (e) {
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
    log.error('telegram webhook failed, will retry', { error: (e as Error).message, retryInSec: Math.round(delay / 1000) });
    const retry = () => void registerWebhook(api, url, secret, delaysMs, attempt + 1);
    setTimeout(retry, delay).unref();
    return false;
  }
};

/**
 * Готовий до роботи Telegram: клієнт + реєстрація вебхука для кнопок (`<publicUrl>/telegram/webhook`).
 * null - токен або чат не задано. Помилка реєстрації вебхука не зупиняє сервіс: реєстрація повторюється у фоні.
 */
export const setupTelegram = async (settings: TelegramSettings): Promise<Telegram | null> => {
  if (!settings.botToken || !settings.chatId) {
    log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: key requests are only saved to DB');
    return null;
  }
  const api = createTelegramApi(settings.botToken);
  const webhookSecret = deriveWebhookSecret(settings.botToken);
  await registerWebhook(api, `${settings.publicUrl}/telegram/webhook`, webhookSecret);
  return { api, chatId: settings.chatId, webhookSecret };
};
