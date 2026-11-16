-- Повідомлення автору видаляються одразу після успішного надсилання в Telegram (вимога користувача, 15.11.2026).
-- У таблиці лишаються лише ті, що не дійшли (telegram_error), тож прапорець telegram_sent не потрібен.
delete from contact_messages where telegram_sent;
alter table contact_messages drop column telegram_sent;
