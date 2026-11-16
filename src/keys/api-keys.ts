// Клієнтські ключі API (таблиця api_keys) і обмеження частоти запитів на ключ.
import { createHash, randomBytes } from 'node:crypto';
import { tx, type Db } from '../core/db.ts';

export type ApiKeyInfo = {
  id: number;
  name: string;
  enabled: boolean;
  created_at: Date;
  last_used_at: Date | null;
};

const KEY_MIN_LENGTH = 8; // для ключів, заданих вручну (поточний ключ 1С - 10 символів); згенеровані - 43
const PUBLIC_COLUMNS = 'id, name, enabled, created_at, last_used_at';

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Новий випадковий ключ: 32 байти, base64url */
const generateKey = (): string => randomBytes(32).toString('base64url');

export class KeyExistsError extends Error {}

/** Шукає увімкнений ключ і одразу позначає час використання (один запит). null - ключ невідомий або вимкнений. */
export const findClientKey = async (db: Db, key: string): Promise<{ id: number; name: string } | null> => {
  const result = await db.query<{ id: number; name: string }>(
    `update api_keys set last_used_at = now()
      where key_hash = $1 and enabled
      returning id, name`,
    [hashKey(key)],
  );
  return result.rows[0] ?? null;
};

/** Кому видано ключ - з заявки, за якою його створено (для ключів, створених вручну, - null) */
export type KeyOwner = { request_id: number; name: string; company: string | null; email: string };

export const listKeys = async (db: Db): Promise<(ApiKeyInfo & { owner: KeyOwner | null })[]> => {
  const result = await db.query<ApiKeyInfo & { owner: KeyOwner | null }>(
    `select k.id, k.name, k.enabled, k.created_at, k.last_used_at,
            case when r.id is null then null
                 else json_build_object('request_id', r.id, 'name', r.name, 'company', r.company, 'email', r.email)
            end as owner
       from api_keys k
       left join key_requests r on r.api_key_id = k.id
      order by k.id`,
  );
  return result.rows;
};

/** Створює ключ. Без `key` - генерує новий. Повертає сам ключ: більше його ніде не побачити. */
export const createKey = async (db: Db, name: string, key?: string): Promise<ApiKeyInfo & { key: string }> => {
  const value = key ?? generateKey();
  if (value.length < KEY_MIN_LENGTH) throw new Error(`key must be at least ${KEY_MIN_LENGTH} characters`);
  const result = await db.query<ApiKeyInfo>(
    `insert into api_keys (name, key_hash) values ($1, $2)
     on conflict (key_hash) do nothing
     returning ${PUBLIC_COLUMNS}`,
    [name, hashKey(value)],
  );
  if (!result.rows[0]) throw new KeyExistsError('this key already exists');
  return { ...result.rows[0], key: value };
};

/** Змінює назву та/або вмикає/вимикає ключ. null - ключа з таким id немає. */
export const updateKey = async (
  db: Db, id: number, changes: { name: string | null; enabled: boolean | null },
): Promise<ApiKeyInfo | null> => {
  const result = await db.query<ApiKeyInfo>(
    `update api_keys
        set name = coalesce($2::text, name),
            enabled = coalesce($3::boolean, enabled)
      where id = $1::int
      returning ${PUBLIC_COLUMNS}`,
    [id, changes.name, changes.enabled],
  );
  return result.rows[0] ?? null;
};

/** Видаляє ключ назавжди (заявка, з якої його створено, лишається - без посилання на ключ). false - ключа немає. */
export const deleteKey = async (db: Db, id: number): Promise<boolean> => {
  return tx(db, async (c) => {
    await c.query('update key_requests set api_key_id = null where api_key_id = $1', [id]);
    const result = await c.query('delete from api_keys where id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  });
};

/**
 * Захист від підбору ключа: після `limit` невдалих спроб з одного IP за вікно `windowMs` цей IP блокується
 * до кінця вікна (рахуються лише невдалі спроби; у пам'яті процесу).
 */
export const createFailureTracker = (limit: number, windowMs: number) => {
  const failures = new Map<string, { slot: number; count: number }>();
  const current = (ip: string, now: number) => {
    const slot = Math.floor(now / windowMs);
    const entry = failures.get(ip);
    return entry && entry.slot === slot ? entry : { slot, count: 0 };
  };
  return {
    /** 0 - можна, інакше скільки секунд чекати */
    blockedFor: (ip: string, now = Date.now()): number => {
      const entry = current(ip, now);
      if (entry.count < limit) return 0;
      return Math.max(1, Math.ceil(((entry.slot + 1) * windowMs - now) / 1000));
    },
    recordFailure: (ip: string, now = Date.now()): void => {
      const entry = current(ip, now);
      entry.count++;
      failures.set(ip, entry);
    },
  };
};

/**
 * Обмеження частоти: не більше `limit` запитів на ключ (id ключа, IP) за календарне вікно `windowMs`
 * (за замовчуванням хвилина), у пам'яті процесу. Повертає 0, якщо можна, інакше - скільки секунд чекати.
 */
export const createRateLimiter = (limit: number, windowMs = 60_000) => {
  const windows = new Map<number | string, { slot: number; count: number }>();
  return (key: number | string, now = Date.now()): number => {
    const slot = Math.floor(now / windowMs);
    const current = windows.get(key);
    const window = current && current.slot === slot ? current : { slot, count: 0 };
    window.count++;
    windows.set(key, window);
    if (window.count <= limit) return 0;
    const nextSlotMs = (slot + 1) * windowMs;
    return Math.max(1, Math.ceil((nextSlotMs - now) / 1000));
  };
};
