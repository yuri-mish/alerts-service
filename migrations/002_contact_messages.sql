-- Повідомлення автору з лендінгу («Написати автору»). Зберігаються завжди (навіть якщо Telegram недоступний).
-- IP відправника не зберігаємо.
create table contact_messages (
    id              serial primary key,
    name            text not null,
    contact         text not null,                 -- email або Telegram для відповіді
    message         text not null,
    created_at      timestamptz not null default now(),
    telegram_sent   boolean not null default false,
    telegram_error  text
);
