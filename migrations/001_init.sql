-- Повна схема бази (міграції 001-007 зведено в одну 15.11.2026; на VPS вони вже були застосовані - схема збігається).
-- Нові зміни схеми - новим файлом 002_...sql.

-- Регіони, за якими робимо запит історії (UID alerts.in.ua).
-- Усі області й м. Київ, крім 16 (Луганська), 29 (АР Крим), 30 (м. Севастополь) - там «вічні» тривоги з 2022.
create table regions (
    uid         integer primary key,
    title       text not null,
    enabled     boolean not null default true,
    created_at  timestamptz not null default now()
);

insert into regions (uid, title) values
    (3, 'Хмельницька область'),
    (4, 'Вінницька область'),
    (5, 'Рівненська область'),
    (8, 'Волинська область'),
    (9, 'Дніпропетровська область'),
    (10, 'Житомирська область'),
    (11, 'Закарпатська область'),
    (12, 'Запорізька область'),
    (13, 'Івано-Франківська область'),
    (14, 'Київська область'),
    (15, 'Кіровоградська область'),
    (17, 'Миколаївська область'),
    (18, 'Одеська область'),
    (19, 'Полтавська область'),
    (20, 'Сумська область'),
    (21, 'Тернопільська область'),
    (22, 'Харківська область'),
    (23, 'Херсонська область'),
    (24, 'Черкаська область'),
    (25, 'Чернігівська область'),
    (26, 'Чернівецька область'),
    (27, 'Львівська область'),
    (28, 'Донецька область'),
    (31, 'м. Київ');

-- Одна тривога з API (id з alerts.in.ua). Може бути по області, району, громаді чи місту.
-- Зберігаються всі типи (alert_type), у звіти (alert_periods) йде лише air_raid.
create table alerts (
    id              bigint primary key,
    region_uid      integer not null references regions (uid),
    location_uid    integer not null,
    location_title  text not null,
    location_type   text not null,
    alert_type      text not null,
    level           text check (level in ('yellow', 'red')),   -- останній відомий рівень
    started_at      timestamptz not null,
    finished_at     timestamptz,
    closed_by       text check (closed_by in ('api', 'stale_30min')),
    api_updated_at  timestamptz,
    first_seen_at   timestamptz not null default now(),
    last_seen_at    timestamptz not null default now()
);
create index alerts_open_idx on alerts (started_at) where finished_at is null;

-- Таблиця для звітів (похідна від alerts, перебудова - `npm run rebuild`):
-- тривога розрізана по київських добах, одна тривога = один відрізок на добу.
create table alert_periods (
    alert_id      bigint not null references alerts (id) on delete cascade,
    month         date not null,                 -- перше число місяця
    region_uid    integer not null,
    location_uid  integer not null,
    level         text,
    started_at    timestamptz not null,
    finished_at   timestamptz,                   -- null, поки триває
    duration_min  integer,                       -- хвилини (округлено), null, поки триває
    day           date not null,                 -- київська доба відрізка
    primary key (alert_id, day)
);
create index alert_periods_month_idx on alert_periods (month, region_uid, level);
create index alert_periods_location_idx on alert_periods (location_uid, month);
create index alert_periods_day_idx on alert_periods (day, location_uid);

-- Журнал прогонів
create table sync_runs (
    id           bigserial primary key,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    trigger      text not null,                  -- schedule | http | cli | startup
    status       text not null default 'running', -- running | ok | partial | error
    details      jsonb not null default '[]'::jsonb,
    error        text
);

-- Клієнтські ключі публічного API: доступ лише до читання даних (/periods, /summary, /1c/alerts, /alerts/{id}).
-- Сам ключ не зберігається - лише sha256; показується один раз при створенні.
-- Ключ адміністратора - env API_KEY (не в таблиці).
create table api_keys (
    id            serial primary key,
    name          text not null,
    key_hash      text not null unique,
    enabled       boolean not null default true,
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz
);

-- Заявки на ключ з лендінгу; рішення - кнопками в Telegram або в адмінці. IP заявника не зберігаємо.
create table key_requests (
    id                   serial primary key,
    name                 text not null,
    company              text,
    purpose              text not null,
    email                text not null,
    created_at           timestamptz not null default now(),
    telegram_sent        boolean not null default false,
    telegram_error       text,
    status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    decided_at           timestamptz,
    api_key_id           int references api_keys (id),
    telegram_message_id  bigint
);
