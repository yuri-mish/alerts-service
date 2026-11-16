// Клієнт alerts.in.ua: історія регіону за останні ~30 днів.
// Ліміт для історії - 2 запити на хвилину; паузу між регіонами тримає sync.ts.

// Єдине місце, де перелічені рівні тривоги: тип і перевірка беруться звідси
export const LEVELS = ['yellow', 'red'] as const;
export type Level = (typeof LEVELS)[number]; // 'yellow' | 'red'

export const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level);

export type ApiAlert = {
  id: number;
  locationUid: number;
  locationTitle: string;
  locationType: string;
  alertType: string;
  level: Level | null;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date | null;
};

export class ApiError extends Error {
  status: number;
  fatal: boolean;
  constructor(message: string, status: number, fatal: boolean) {
    super(message);
    this.status = status;
    this.fatal = fatal; // 401/403: немає сенсу продовжувати з іншими регіонами
  }
}

export type Fetcher = (uid: number) => Promise<ApiAlert[]>;

const BASE = 'https://api.alerts.in.ua';
const MAX_ATTEMPTS = 3; // кількість спроб запиту до API (мережа, 429, 5xx)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const createFetcher = (token: string, opts: { retryDelayMs?: number } = {}): Fetcher => {
  const retryDelay = opts.retryDelayMs ?? 61_000;
  return async (uid) => {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BASE}/v1/regions/${uid}/alerts/month_ago.json`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw new ApiError(`network: ${(e as Error).message}`, 0, false);
        await sleep(retryDelay);
        continue;
      }
      if (res.ok) return parseHistory(await res.json());
      const body = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(`API ${res.status}: ${body}`, res.status, true);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay);
        continue;
      }
      throw new ApiError(`API ${res.status}: ${body}`, res.status, false);
    }
  };
};

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toLevel = (v: unknown): Level | null => (isLevel(v) ? v : null);

// Один запис з API -> ApiAlert; null, якщо запис битий (немає id, території або початку)
const parseAlert = (raw: Record<string, unknown>): ApiAlert | null => {
  const id = toInt(raw.id);
  const locationUid = toInt(raw.location_uid);
  const startedAt = toDate(raw.started_at);
  if (id === null || locationUid === null || startedAt === null) return null;

  return {
    id,
    locationUid,
    locationTitle: String(raw.location_title ?? ''),
    locationType: String(raw.location_type ?? 'unknown'),
    alertType: String(raw.alert_type ?? 'air_raid'),
    level: toLevel(raw.alert_level),
    startedAt,
    finishedAt: toDate(raw.finished_at),
    updatedAt: toDate(raw.updated_at),
  };
};

export const parseHistory = (json: unknown): ApiAlert[] => {
  const list = (json as { alerts?: unknown })?.alerts;
  if (!Array.isArray(list)) throw new ApiError('unexpected response: no "alerts" array', 200, false);

  const parsed = list.map(parseAlert);
  return parsed.filter((alert): alert is ApiAlert => alert !== null); // биті записи пропускаємо
};
