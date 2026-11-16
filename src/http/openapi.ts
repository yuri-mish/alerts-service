// Специфікація OpenAPI 3.1 для клієнтських ендпоінтів (GET /openapi.json, сторінка Swagger UI - /docs).
// Параметри запитів генеруються зі схем zod (handlers/data.ts) - опис не розходиться з перевіркою.
// Ендпоінти адміністратора свідомо не описуємо.
import { z } from 'zod';
import { config } from '../core/config.ts';
import { oneCQuery, periodsQuery, summaryQuery } from './handlers/data.ts';

/** Пояснення до параметрів рядка запиту (однакові назви - однаковий зміст у всіх ендпоінтах) */
const PARAM_DESCRIPTIONS: Record<string, string> = {
  month: 'Місяць у форматі YYYY-MM, напр. 2026-11',
  region: 'UID областей через кому, напр. 14,31 (31 - м. Київ, 14 - Київська обл.). Потрібен `region` або `location`',
  location:
    'UID територій (районів, громад, міст) через кому, напр. 75 (Бучанський район). Потрібен `region` або `location`',
  level: 'Рівень тривоги',
  limit: 'Найбільше рядків у відповіді (за замовчуванням 50 000, не більше 200 000)',
  format: '`csv` - файл для Excel (роздільник `;`, кодування UTF-8 з BOM); без параметра - JSON',
  by: '`location` - окремий рядок для кожної території; без параметра - підсумок по регіону',
};

/** JSON Schema поля (як його вводить клієнт - рядок до перетворення) без службового $schema */
const inputSchema = (field: z.ZodType): object => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(field, { io: 'input' });
  return schema;
};

/** Параметри OpenAPI з полів схеми zod; обов'язкове - те, без чого схема не проходить */
const queryParameters = (schema: z.ZodObject) =>
  Object.entries(schema.shape).map(([name, field]) => ({
    name,
    in: 'query',
    required: !field.safeParse(undefined).success,
    description: PARAM_DESCRIPTIONS[name],
    schema: inputSchema(field),
  }));

const json = (schema: object, example?: unknown) => ({ 'application/json': { schema, example } });

const ERROR_SCHEMA = { type: 'object', properties: { error: { type: 'string' } } };

/**
 * Відповідь з помилкою: опис коду і справжні тексти `error`, які повертає сервер для цього коду
 * (кілька - випадаючим списком прикладів у Swagger UI).
 */
const errorResponse = (description: string, examples: Record<string, string>) => ({
  description,
  content: {
    'application/json': {
      schema: ERROR_SCHEMA,
      examples: Object.fromEntries(
        Object.entries(examples).map(([summary, error], i) => [`example${i + 1}`, { summary, value: { error } }]),
      ),
    },
  },
});

const ERRORS = {
  400: errorResponse('Неправильні параметри (у `error` - яке саме поле і що не так)', {
    'Місяць не у форматі YYYY-MM': 'month: must be YYYY-MM',
    'Не вказано ні region, ні location': 'specify region or location (at least one)',
    'Невідомий параметр (опечатка)': 'Unrecognized key: "levle"',
    'Неправильний рівень': 'level: must be yellow or red',
  }),
  401: errorResponse('Немає ключа або ключ невідомий/вимкнений', {
    'Ключ не передано, невідомий або вимкнений': 'X-Api-Key required',
  }),
  429: {
    ...errorResponse('Забагато запитів: понад 6 на хвилину на ключ, або 5 неправильних ключів з IP за годину', {
      'Понад 6 запитів за хвилину на ключ': 'rate limit exceeded, retry in 42s',
      '5 неправильних ключів з IP за годину': 'too many invalid keys, retry in 1800s',
    }),
    headers: { 'Retry-After': { description: 'Через скільки секунд можна повторити', schema: { type: 'integer' } } },
  },
};

const LOCAL_TIME = { type: ['string', 'null'], description: 'Київський час' };

const periodItem = {
  type: 'object',
  properties: {
    region_uid: { type: 'integer', description: 'UID області' },
    location_uid: { type: 'integer', description: 'UID території (район, громада, місто)' },
    location_title: { type: 'string' },
    location_type: { type: 'string', examples: ['raion', 'hromada', 'city', 'oblast'] },
    level: { type: ['string', 'null'], enum: ['yellow', 'red', null] },
    month: { type: 'string', examples: ['2026-11'] },
    day: { type: 'string', format: 'date', description: 'Доба (київська) цього відрізка' },
    started_local: { ...LOCAL_TIME, examples: ['2026-11-12 10:15:00'] },
    finished_local: { ...LOCAL_TIME, description: 'Київський час; null - тривога триває' },
    duration_min: { type: ['integer', 'null'] },
    alert_id: { type: 'integer' },
    closed_by: {
      type: ['string', 'null'],
      description: '`stale_30min` - джерело понад 3 доби не дало кінця, закрито як початок + 30 хв',
    },
    started_at: { type: 'string', format: 'date-time', description: 'UTC' },
    finished_at: { type: ['string', 'null'], format: 'date-time', description: 'UTC' },
  },
};

const oneCItem = {
  type: 'object',
  properties: {
    ПериодМесяц: { type: 'string', examples: ['2026-11-01T00:00:00'] },
    ДеньМесяца: { type: 'integer', examples: [12] },
    КодТеритории: { type: 'integer', examples: [75] },
    ТипСобытия: { type: 'string', enum: ['Тревога'] },
    НомерТревоги: { type: 'integer', description: 'Порядковий номер тривоги в межах території і доби' },
    Начало: { type: 'string', examples: ['2026-11-12T10:15:00'] },
    Конец: { type: ['string', 'null'], description: 'null - тривога ще триває' },
  },
};

const summaryItem = {
  type: 'object',
  properties: {
    region_uid: { type: 'integer' },
    location_uid: { type: 'integer', description: 'Лише з `by=location`' },
    location_title: { type: 'string', description: 'Лише з `by=location`' },
    level: { type: 'string', enum: ['yellow', 'red', 'unknown', 'all'], description: '`all` - усі рівні разом' },
    alerts: { type: 'integer', description: 'Кількість тривог' },
    hours: {
      type: 'number',
      description: 'Години тривоги: перекриття тривог рахуються один раз; активна - до поточного моменту',
    },
    still_active: { type: 'integer', description: 'Скільки з них ще триває' },
  },
};

const csvContent = { 'text/csv': { schema: { type: 'string' } } };

export const createOpenApiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: 'API історії повітряних тривог',
    version: '1.0.0',
    description:
      'Історія повітряних тривог по областях, районах і громадах України (джерело - alerts.in.ua), ' +
      'оновлюється щоночі. Тривоги розрізані по добах (київський час): одна тривога через північ - два рядки. ' +
      'Тривоги, що ще тривали на момент нічного оновлення, теж є (кінець - null) - як бонус; ' +
      'для стану тривог у реальному часі сервіс не призначений. ' +
      'У кожному запиті потрібна хоча б одна територія: `region` або `location`. ' +
      'Ключ - у заголовку `X-Api-Key` (отримати - на головній сторінці). Ліміт - 6 запитів на хвилину на ключ.',
  },
  servers: [{ url: config.publicUrl }],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
  },
  paths: {
    '/1c/alerts': {
      get: {
        tags: ['Тривоги'],
        operationId: 'getOneCAlerts',
        summary: 'Вигрузка для 1С: рядок на кожну добу тривоги',
        description: 'Поля названі як реквізити 1С; час - київський ISO (1С читає як Дата).',
        parameters: queryParameters(oneCQuery),
        responses: {
          200: {
            description: 'Тривоги за місяць',
            content: { ...json({ type: 'array', items: oneCItem }), ...csvContent },
          },
          ...ERRORS,
        },
      },
    },
    '/periods': {
      get: {
        tags: ['Тривоги'],
        operationId: 'getPeriods',
        summary: 'Відрізки тривог по добах',
        description: 'Потрібна хоча б одна територія: `region` або `location`; `month` - необов’язковий.',
        parameters: queryParameters(periodsQuery),
        responses: {
          200: { description: 'Відрізки', content: { ...json({ type: 'array', items: periodItem }), ...csvContent } },
          ...ERRORS,
        },
      },
    },
    '/summary': {
      get: {
        tags: ['Тривоги'],
        operationId: 'getSummary',
        summary: 'Підсумок за місяць: кількість тривог і години по рівнях',
        parameters: queryParameters(summaryQuery),
        responses: {
          200: { description: 'Підсумок', content: json({ type: 'array', items: summaryItem }) },
          ...ERRORS,
        },
      },
    },
    '/alerts/{id}': {
      get: {
        tags: ['Тривоги'],
        operationId: 'getAlert',
        summary: 'Одна тривога з її відрізками по добах',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'Тривога', content: json({ type: 'object' }) },
          404: errorResponse('Тривоги з таким id немає', { 'Тривоги немає': 'alert not found' }),
          401: ERRORS[401],
          429: ERRORS[429],
        },
      },
    },
  },
});
