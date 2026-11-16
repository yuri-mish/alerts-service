// «Написати автору» з лендінгу: перевірка, збереження в БД, пересилання в Telegram адміну.
import type { Db } from '../core/db.ts';
import { log } from '../core/log.ts';
import type { Telegram } from './telegram.ts';
import { z } from 'zod';
import { isBotSubmission, requiredText, validate } from '../core/validation.ts';

/** Поля форми «Написати автору» */
const contactMessageSchema = z.object({
  name: requiredText(100),
  contact: requiredText(200),
  message: requiredText(3000),
});

export type ContactMessage = z.infer<typeof contactMessageSchema>;

/** Перевіряє форму (помилка -> ValidationError); бот (заповнена пастка `website`) -> 'bot' */
export const parseContactMessage = (body: unknown): ContactMessage | 'bot' => {
  if (isBotSubmission(body)) return 'bot';
  return validate(contactMessageSchema, body);
};

const formatMessage = (id: number, contactMessage: ContactMessage): string => {
  const lines = [
    `✉️ Повідомлення з сайту №${id}`,
    `Від: ${contactMessage.name}`,
    `Для відповіді: ${contactMessage.contact}`,
    '',
    contactMessage.message,
  ];
  return lines.join('\n');
};

/**
 * Повторно надсилає повідомлення, які раніше не дійшли (є telegram_error), і видаляє їх після успіху.
 * Якщо Telegram досі недоступний - зупиняється на першій помилці (решта - наступного разу).
 * Повертає кількість доставлених.
 */
export const resendContactMessages = async (db: Db, send: (text: string) => Promise<void>): Promise<number> => {
  const pending = await db.query<ContactMessage & { id: number }>(
    'select id, name, contact, message from contact_messages where telegram_error is not null order by id',
  );
  let delivered = 0;
  for (const row of pending.rows) {
    try {
      await send(`${formatMessage(row.id, row)}\n\n(доставлено із запізненням)`);
    } catch (e) {
      await db.query('update contact_messages set telegram_error = $2 where id = $1', [row.id, (e as Error).message]);
      break;
    }
    await db.query('delete from contact_messages where id = $1', [row.id]);
    delivered++;
  }
  if (delivered) log.info('contact messages resent', { delivered });
  return delivered;
};

/**
 * Зберігає повідомлення, пересилає в Telegram і після успішного надсилання видаляє з бази.
 * Якщо Telegram недоступний - повідомлення лишається в базі з telegram_error, щоб не загубилось.
 */
export const submitContactMessage = async (
  db: Db,
  telegram: Telegram | null,
  contactMessage: ContactMessage,
): Promise<number> => {
  const inserted = await db.query<{ id: number }>(
    'insert into contact_messages (name, contact, message) values ($1, $2, $3) returning id',
    [contactMessage.name, contactMessage.contact, contactMessage.message],
  );
  const id = inserted.rows[0].id;
  if (!telegram) {
    log.warn('contact message saved, telegram is not configured', { id });
    return id;
  }
  try {
    await telegram.api.sendMessage(telegram.chatId, formatMessage(id, contactMessage));
    await db.query('delete from contact_messages where id = $1', [id]);
  } catch (e) {
    const error = (e as Error).message;
    log.error('contact message telegram failed', { id, error });
    await db.query('update contact_messages set telegram_error = $2 where id = $1', [id, error]);
  }
  return id;
};
