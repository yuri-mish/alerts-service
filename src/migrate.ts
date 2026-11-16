import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool, tx, type Db } from './core/db.ts';
import { config } from './core/config.ts';
import { log } from './core/log.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Назви міграцій, які вже застосовані до бази
const getAppliedNames = async (db: Db): Promise<Set<string>> => {
  const result = await db.query('select name from schema_migrations');
  const names = result.rows.map((row) => row.name);
  return new Set(names);
};

// Файли міграцій з папки, за назвою (порядок застосування)
const getMigrationFiles = async (): Promise<string[]> => {
  const allFiles = await readdir(dir);
  const sqlFiles = allFiles.filter((file) => file.endsWith('.sql'));
  return sqlFiles.sort();
};

// Виконує один файл і записує його в schema_migrations (в одній транзакції)
const applyMigration = async (db: Db, file: string): Promise<void> => {
  const sql = await readFile(path.join(dir, file), 'utf8');
  await tx(db, async (client) => {
    await client.query(sql);
    await client.query('insert into schema_migrations (name) values ($1)', [file]);
  });
  log.info('migration applied', { name: file });
};

export const migrate = async (db: Db): Promise<void> => {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);

  const applied = await getAppliedNames(db);
  const files = await getMigrationFiles();

  for (const file of files) {
    if (applied.has(file)) continue;
    await applyMigration(db, file);
  }
};

if (import.meta.main) {
  const db = createPool(config.databaseUrl);
  await migrate(db);
  await db.end();
}
