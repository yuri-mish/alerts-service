// Для тестів без бази: config.ts вимагає DATABASE_URL при імпорті, а підключення в цих тестах не відкривається.
// Імпортувати першим рядком файлу тестів (до модулів src/).
process.env.DATABASE_URL ??= 'postgres://unit-tests@localhost/no-db';
