// Заявки на ключ: форма лендінгу, кнопки в Telegram, адмінка.
// Потрібен Postgres: DATABASE_URL (тести працюють в окремій схемі).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/http/server.ts';
import { db, fetcher, ADMIN_CHAT, fakeTelegram } from './helpers.ts';
import type { AddressInfo } from 'node:net';

test('заявка на ключ: перевірка полів, збереження, Telegram, пастка для ботів, ліміт з IP', async () => {
  const fake = fakeTelegram();
  const sent = fake.sent;
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: object, ip: string) =>
    fetch(`${base}/key-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify(body),
    });
  const form = { name: 'Іван', company: 'ТОВ "Тест"', purpose: 'звіти в 1С', email: 'ivan@example.com' };
  try {
    // помилки полів (невдалі спроби теж рахуються в ліміт, тому кожна - з іншого IP)
    assert.equal((await post({ ...form, email: 'не-email' }, '10.0.0.1')).status, 400);
    assert.equal((await post({ ...form, name: '  ' }, '10.0.0.2')).status, 400);
    assert.equal((await post({ ...form, purpose: 'x'.repeat(1001) }, '10.0.0.3')).status, 400);

    // успішна заявка: збережено і надіслано, компанія необов'язкова
    const ok = await post({ ...form, company: '' }, '10.0.0.4');
    assert.equal(ok.status, 201);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Іван/);
    assert.match(sent[0].text, /ivan@example\.com/);
    assert.match(sent[0].text, /Компанія: -/);
    assert.doesNotMatch(sent[0].text, /IP|10\.0\.0\.4/); // IP заявника нікуди не йде
    let row = (
      await db.query(
        'select id, company, telegram_sent, status, telegram_message_id from key_requests order by id desc limit 1',
      )
    ).rows[0];
    assert.deepEqual(sent[0].buttons, [
      [
        { text: '✅ Прийняти', callback_data: `approve:${row.id}` },
        { text: '❌ Відмовити', callback_data: `reject:${row.id}` },
      ],
    ]);
    assert.deepEqual(row, {
      id: row.id,
      company: null,
      telegram_sent: true,
      status: 'pending',
      telegram_message_id: sent[0].messageId,
    });

    // бот заповнив приховане поле: 201, але нічого не збережено й не надіслано
    const before = (await db.query('select count(*)::int as n from key_requests')).rows[0].n;
    assert.equal((await post({ ...form, website: 'http://spam' }, '10.0.0.5')).status, 201);
    assert.equal((await db.query('select count(*)::int as n from key_requests')).rows[0].n, before);
    assert.equal(sent.length, 1);

    // Telegram недоступний: заявка все одно збережена, помилка записана
    fake.fail(true);
    assert.equal((await post(form, '10.0.0.6')).status, 201);
    row = (await db.query('select telegram_sent, telegram_error from key_requests order by id desc limit 1')).rows[0];
    assert.equal(row.telegram_sent, false);
    assert.match(row.telegram_error, /Telegram 500/);
    fake.fail(false);

    // ліміт: 3 заявки з одного IP на годину
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(form, '10.0.0.7')).status);
    assert.deepEqual(statuses, [201, 201, 201, 429]);
  } finally {
    server.close();
  }
});

test('кнопки в Telegram: «Прийняти» створює робочий ключ, «Відмовити» - лист з відмовою; секрет і права', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = async (name: string, ip: string) => {
    await fetch(`${base}/key-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify({ name, purpose: 'тест', email: `${name}@example.com` }),
    });
    return (await db.query('select id from key_requests where name = $1', [name])).rows[0].id as number;
  };
  let clickNo = 0;
  const click = (data: string, fromId = ADMIN_CHAT, secret = fake.telegram.webhookSecret) =>
    fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({
        update_id: ++clickNo,
        callback_query: { id: `cb${clickNo}`, from: { id: fromId }, data },
      }),
    });
  const status = async (id: number) =>
    (await db.query('select status, api_key_id from key_requests where id = $1', [id])).rows[0];
  try {
    const approveId = await submit('approve-me', '10.1.0.1');
    const rejectId = await submit('reject-me', '10.1.0.2');

    // без секрету / з чужим секретом - 401, нічого не змінюється
    assert.equal((await click(`approve:${approveId}`, ADMIN_CHAT, 'wrong')).status, 401);
    // не адмін натиснув кнопку - відмова в правах
    assert.equal((await click(`approve:${approveId}`, 999)).status, 200);
    assert.equal(fake.answers.at(-1), 'Немає прав');
    assert.equal((await status(approveId)).status, 'pending');

    // «Прийняти»: ключ створено, повідомлення оновлено без кнопок, лист із ключем надіслано адміну
    assert.equal((await click(`approve:${approveId}`)).status, 200);
    const approved = await status(approveId);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.api_key_id);
    assert.match(fake.edits.at(-1)!.text, new RegExp(`✅ Прийнято .*ключ №${approved.api_key_id}`));
    const letter = fake.sent.at(-1)!.text;
    assert.match(letter, /Кому: approve-me@example\.com/);
    const key = /Ваш ключ API:\n(\S+)/.exec(letter)![1];
    // ключ із листа працює як клієнтський
    assert.equal(
      (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: { 'X-Api-Key': key } })).status,
      200,
    );
    assert.equal((await fetch(`${base}/runs`, { headers: { 'X-Api-Key': key } })).status, 403);

    // повторне натискання - «вже оброблено», другий ключ не створюється
    const keysBefore = (await db.query('select count(*)::int as n from api_keys')).rows[0].n;
    await click(`approve:${approveId}`);
    assert.equal(fake.answers.at(-1), 'Заявку вже оброблено');
    assert.equal((await db.query('select count(*)::int as n from api_keys')).rows[0].n, keysBefore);

    // «Відмовити»: статус, повідомлення оновлено, лист з відмовою, ключа немає
    await click(`reject:${rejectId}`);
    assert.deepEqual(await status(rejectId), { status: 'rejected', api_key_id: null });
    assert.match(fake.edits.at(-1)!.text, /❌ Відмовлено/);
    assert.match(fake.sent.at(-1)!.text, /Кому: reject-me@example\.com[\s\S]*не можемо надати ключ/);
    // після відмови прийняти вже не можна
    await click(`approve:${rejectId}`);
    assert.equal(fake.answers.at(-1), 'Заявку вже оброблено');
  } finally {
    server.close();
  }
});

test('адмінка: сторінка, список заявок, рішення з адмінки (з оновленням Telegram), видалення ключа', async () => {
  const fake = fakeTelegram();
  const server = createServer({ db, fetcher, adminKey: 'admin-key', rateLimitPerMin: 5, telegram: fake.telegram });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { 'X-Api-Key': 'admin-key', 'Content-Type': 'application/json' };
  const submit = async (name: string, ip: string) => {
    await fetch(`${base}/key-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify({ name, purpose: 'адмінка', email: `${name}@example.com` }),
    });
    return (await db.query('select id from key_requests where name = $1', [name])).rows[0].id as number;
  };
  try {
    // сторінка адмінки відкривається без ключа, але не індексується: заголовок X-Robots-Tag + мета-тег;
    // у robots.txt її немає (інакше робот не побачить noindex, а адреса адмінки стане публічною)
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(await page.text(), /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(await (await fetch(`${base}/robots.txt`)).text(), /admin/);
    assert.equal((await fetch(`${base}/`)).headers.get('x-robots-tag'), null); // лендінг індексується

    const approveId = await submit('admin-approve', '10.2.0.1');
    const rejectId = await submit('admin-reject', '10.2.0.2');

    // список заявок - лише адміну; ті, що чекають, - першими
    const client = await (
      await fetch(`${base}/keys`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'клієнт' }) })
    ).json();
    assert.equal((await fetch(`${base}/key-requests`, { headers: { 'X-Api-Key': client.key } })).status, 403);
    assert.equal((await fetch(`${base}/key-requests`)).status, 401);
    const list = (await (await fetch(`${base}/key-requests`, { headers: admin })).json()) as {
      id: number;
      status: string;
    }[];
    const firstDecided = list.findIndex((r) => r.status !== 'pending');
    assert.ok(firstDecided === -1 || list.slice(firstDecided).every((r) => r.status !== 'pending'));
    assert.ok(list.some((r) => r.id === approveId));

    // «Прийняти» з адмінки: ключ у відповіді, лист, повідомлення в Telegram оновлено з позначкою «в адмінці»
    const approved = await fetch(`${base}/key-requests/${approveId}/approve`, { method: 'POST', headers: admin });
    assert.equal(approved.status, 200);
    const decision = (await approved.json()) as { status: string; key: { id: number; value: string }; letter: string };
    assert.equal(decision.status, 'approved');
    assert.match(decision.letter, new RegExp(`Кому: admin-approve@example\\.com[\\s\\S]*${decision.key.value}`));
    assert.match(fake.edits.at(-1)!.text, /✅ Прийнято .*\(в адмінці\)/);
    assert.equal(
      (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: { 'X-Api-Key': decision.key.value } })).status,
      200,
    );
    // повторно - 409
    assert.equal(
      (await fetch(`${base}/key-requests/${approveId}/reject`, { method: 'POST', headers: admin })).status,
      409,
    );

    // у списку ключів видно, кому видано: з заявки - ім'я, email, № заявки; створений вручну - owner null
    const keys = (await (await fetch(`${base}/keys`, { headers: admin })).json()) as { id: number; owner: unknown }[];
    assert.deepEqual(keys.find((k) => k.id === decision.key.id)?.owner, {
      request_id: approveId,
      name: 'admin-approve',
      company: null,
      email: 'admin-approve@example.com',
    });
    assert.equal(keys.find((k) => k.id === client.id)?.owner, null);

    // «Відмовити» з адмінки
    const rejected = await (
      await fetch(`${base}/key-requests/${rejectId}/reject`, { method: 'POST', headers: admin })
    ).json();
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.key, null);
    assert.match(rejected.letter, /не можемо надати ключ/);

    // видалення ключа: ключ перестає працювати, заявка лишається без посилання на ключ
    assert.equal((await fetch(`${base}/keys/${decision.key.id}`, { method: 'DELETE', headers: admin })).status, 200);
    assert.equal(
      (await fetch(`${base}/summary?month=2026-11&region=31`, { headers: { 'X-Api-Key': decision.key.value } })).status,
      401,
    );
    const row = (await db.query('select status, api_key_id from key_requests where id = $1', [approveId])).rows[0];
    assert.deepEqual(row, { status: 'approved', api_key_id: null });
    assert.equal((await fetch(`${base}/keys/${decision.key.id}`, { method: 'DELETE', headers: admin })).status, 404);
    assert.equal(
      (await fetch(`${base}/keys/${client.id}`, { method: 'DELETE', headers: { 'X-Api-Key': client.key } })).status,
      403,
    );
  } finally {
    server.close();
  }
});
