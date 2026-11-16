// Швидкі тести без бази: розбір відповіді API, ліміти, повтор реєстрації вебхука, схеми перевірки.
// База не потрібна.
import './no-db-env.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFailureTracker, createRateLimiter } from '../src/keys/api-keys.ts';
import { registerWebhook, type TelegramApi } from '../src/notify/telegram.ts';
import { parseHistory } from '../src/sync/alerts-api.ts';
import { z } from 'zod';
import { validate, ValidationError } from '../src/core/validation.ts';
import { parseKeyRequest } from '../src/keys/key-requests.ts';
import { parseContactMessage } from '../src/notify/contact.ts';
import { intListField, levelField, monthField } from '../src/http/common.ts';

test('parseHistory: location_uid рядком, alert_level, null кінець', () => {
  const r = parseHistory({
    alerts: [
      {
        id: 5,
        location_uid: '94',
        location_title: 'Бучанська громада',
        location_type: 'hromada',
        location_oblast_uid: 14,
        alert_type: 'air_raid',
        alert_level: 'red',
        started_at: '2026-11-01T10:00:00.000Z',
        finished_at: null,
        updated_at: '2026-11-01T10:05:00.000Z',
      },
      { id: 'bad' },
    ],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].locationUid, 94);
  assert.equal(r[0].level, 'red');
  assert.equal(r[0].finishedAt, null);
});

test('ліміт запитів: N за календарну хвилину на ключ, окремо для кожного ключа', () => {
  const limiter = createRateLimiter(2);
  const t = Date.parse('2026-11-14T10:00:10Z');
  assert.equal(limiter(1, t), 0);
  assert.equal(limiter(1, t + 1000), 0);
  assert.equal(limiter(1, t + 2000), 48); // третій у тій самій хвилині -> чекати до 10:01:00
  assert.equal(limiter(2, t + 2000), 0); // інший ключ - свій лічильник
  assert.equal(limiter(1, t + 50_000), 0); // нова хвилина
});

test('захист від підбору: після N невдалих спроб IP блокується до кінця вікна', () => {
  const tracker = createFailureTracker(3, 15 * 60_000);
  const t = Date.parse('2026-11-15T10:00:00Z');
  for (let i = 0; i < 3; i++) {
    assert.equal(tracker.blockedFor('1.1.1.1', t), 0);
    tracker.recordFailure('1.1.1.1', t);
  }
  assert.equal(tracker.blockedFor('1.1.1.1', t + 60_000), 14 * 60); // до 10:15
  assert.equal(tracker.blockedFor('2.2.2.2', t), 0); // інший IP
  assert.equal(tracker.blockedFor('1.1.1.1', t + 15 * 60_000), 0); // нове вікно
});

test('вебхук Telegram: якщо реєстрація не вдалася - повторює у фоні, доки не вдасться', async () => {
  let calls = 0;
  const registered: string[] = [];
  const api: TelegramApi = {
    sendMessage: async () => 1,
    editMessage: async () => {},
    answerCallback: async () => {},
    setWebhook: async (url) => {
      calls++;
      if (calls <= 2) throw new Error('Telegram недоступний');
      registered.push(url);
    },
  };
  const first = await registerWebhook(api, 'https://example.test/telegram/webhook', 'secret', [10, 20]);
  assert.equal(first, false); // перша спроба невдала, далі - у фоні
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 3); // 2 невдалі + 1 вдала, далі спроби припиняються
  assert.deepEqual(registered, ['https://example.test/telegram/webhook']);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 3);
});

test('схеми форм: обов’язкові поля, обрізання пробілів, довжина, email, пастка для ботів', () => {
  const form = { name: ' Іван ', company: '  ', purpose: 'облік у 1С', email: 'ivan@firma.ua' };
  assert.deepEqual(parseKeyRequest(form), {
    name: 'Іван',
    company: null,
    purpose: 'облік у 1С',
    email: 'ivan@firma.ua',
  });
  assert.throws(() => parseKeyRequest({ ...form, email: 'не-email' }), { message: 'email: invalid' });
  assert.throws(() => parseKeyRequest({ ...form, name: '   ' }), { message: 'name: required' });
  assert.throws(() => parseKeyRequest({ purpose: 'x', email: 'a@b.ua' }), { message: 'name: required' });
  assert.throws(() => parseKeyRequest({ ...form, purpose: 'x'.repeat(1001) }), {
    message: 'purpose: too long (max 1000)',
  });
  assert.throws(() => parseKeyRequest(undefined), ValidationError);
  assert.equal(parseKeyRequest({ ...form, website: 'spam.example' }), 'bot');

  const message = { name: 'Оля', contact: '@olya', message: 'Привіт' };
  assert.deepEqual(parseContactMessage(message), message);
  assert.throws(() => parseContactMessage({ ...message, contact: ' ' }), { message: 'contact: required' });
  assert.throws(() => parseContactMessage({ ...message, message: 'x'.repeat(3001) }), ValidationError);
  assert.equal(parseContactMessage({ website: 'x' }), 'bot');
});

test('поля рядка запиту: місяць, список цілих, рівень', () => {
  const query = z.object({
    month: monthField.optional(),
    region: intListField.optional(),
    level: levelField.optional(),
  });
  assert.deepEqual(validate(query, { month: '2026-11', region: '14, 31,14', level: 'red' }), {
    month: '2026-11-01',
    region: [14, 31],
    level: 'red',
  });
  assert.throws(() => validate(query, { month: '2026-13' }), { message: 'month: must be YYYY-MM' });
  assert.throws(() => validate(query, { region: '14,abc' }), {
    message: 'region: must be integers separated by commas',
  });
  assert.throws(() => validate(query, { level: 'blue' }), { message: 'level: must be yellow or red' });
  assert.throws(() => validate(z.object({ month: monthField }), {}), { message: 'month: required (YYYY-MM)' });
  const tooMany = Array.from({ length: 201 }, (_, i) => i).join(',');
  assert.throws(() => validate(query, { region: tooMany }), { message: 'region: too many values (max 200)' });
});
