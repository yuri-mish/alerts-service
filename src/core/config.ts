// Конфігурація з env. Читається один раз при імпорті модуля; усі інші модулі беруть `config`.
// Обов'язковий лише DATABASE_URL; ALERTS_TOKEN і API_KEY кожна точка входу перевіряє сама через requireConfig.

const readEnv = (name: string): string => process.env[name]?.trim() ?? '';

const readDatabaseUrl = (): string => {
  const url = readEnv('DATABASE_URL');
  if (!url) throw new Error('env DATABASE_URL is not set');
  return url;
};

/** HH:MM, напр. 03:30 */
const readSyncTime = (): string => {
  const value = readEnv('SYNC_TIME') || '03:30';
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error('SYNC_TIME must be HH:MM');
  return value;
};

/** Справжня IANA-зона (інакше Intl кидає RangeError); за замовчуванням Europe/Kyiv */
const readTimeZone = (): string => {
  const name = readEnv('TIME_ZONE') || 'Europe/Kyiv';
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
  } catch {
    throw new Error(`env TIME_ZONE is not a valid IANA time zone: ${name}`);
  }
  return name;
};

const readPort = (): number => {
  const port = Number(readEnv('PORT') || 6020);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  return port;
};

/** Запитів на хвилину для одного клієнтського ключа (ключ адміністратора не обмежується) */
const readRateLimit = (): number => {
  const value = Number(readEnv('RATE_LIMIT_PER_MIN') || 6);
  if (!Number.isInteger(value) || value < 1) throw new Error('RATE_LIMIT_PER_MIN must be a positive integer');
  return value;
};

export const config = {
  databaseUrl: readDatabaseUrl(),
  alertsToken: readEnv('ALERTS_TOKEN'),
  /** Ключ адміністратора (env API_KEY): доступ до всіх ендпоінтів */
  apiKey: readEnv('API_KEY'),
  rateLimitPerMin: readRateLimit(),
  /** Telegram для заявок на ключ (необов'язково: без них заявки лише зберігаються в БД) */
  telegramBotToken: readEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId: readEnv('TELEGRAM_CHAT_ID'),
  /** Тека з бекапами (*.dump) для перевірки свіжості; у контейнері змонтована лише для читання */
  monitorBackupDir: readEnv('MONITOR_BACKUP_DIR') || '/backups',
  /** Публічна адреса сервісу: посилання в листах і адреса вебхука Telegram */
  publicUrl: (readEnv('PUBLIC_URL') || 'https://alerts.starsam.net').replace(/\/+$/, ''),
  host: readEnv('HOST') || '127.0.0.1',
  port: readPort(),
  syncTime: readSyncTime(), // у зоні timeZone
  /** За цією зоною рахуються доби, місяці, розклад (syncTime) і час у відповідях API */
  timeZone: readTimeZone(),
};

const ENV_NAMES = { alertsToken: 'ALERTS_TOKEN', apiKey: 'API_KEY' } as const;

/** Для точок входу, яким потрібні необов'язкові за замовчуванням змінні: кидає помилку, якщо порожні */
export const requireConfig = (...keys: (keyof typeof ENV_NAMES)[]): void => {
  for (const key of keys) {
    if (!config[key]) throw new Error(`env ${ENV_NAMES[key]} is not set`);
  }
};
