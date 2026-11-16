// Разовий прогін з консолі:  node src/sync-once.ts
import { config, requireConfig } from './core/config.ts';
import { createPool } from './core/db.ts';
import { migrate } from './migrate.ts';
import { createFetcher } from './sync/alerts-api.ts';
import { startSync } from './sync/sync.ts';

requireConfig('alertsToken');
const db = createPool(config.databaseUrl);
await migrate(db);
const { done } = await startSync(db, createFetcher(config.alertsToken), 'cli');
console.log(JSON.stringify(await done, null, 2));
await db.end();
