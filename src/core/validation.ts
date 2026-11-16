// Перевірка вхідних даних схемами zod: спільні поля і validate(), що кидає ValidationError (-> HTTP 400).
import { z } from 'zod';

/** Дані не пройшли перевірку; HTTP-сервер відповідає 400 з текстом помилки */
export class ValidationError extends Error {}

/** Обов'язковий текст: обрізаються пробіли, порожній -> "required", довший за max -> "too long" */
export const requiredText = (max: number) => z
  .string({ error: 'required' })
  .trim()
  .min(1, 'required')
  .max(max, `too long (max ${max})`);

/** Необов'язковий текст: відсутній, null або порожній -> null */
export const optionalText = (max: number) => z
  .string()
  .trim()
  .max(max, `too long (max ${max})`)
  .nullish()
  .transform((value) => value || null);

/** Приховане поле-пастка `website` у формах лендінгу: людина його не бачить, бот заповнює */
export const isBotSubmission = (body: unknown): boolean => {
  const website = (body as { website?: unknown } | null)?.website;
  return typeof website === 'string' && website.trim() !== '';
};

/** Перевіряє дані схемою; помилка -> ValidationError з першою проблемою, напр. "email: invalid" */
export const validate = <Schema extends z.ZodType>(schema: Schema, data: unknown): z.output<Schema> => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue.path.join('.');
  throw new ValidationError(where ? `${where}: ${issue.message}` : issue.message);
};
