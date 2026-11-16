// Повна перебудова alert_periods з alerts:  npm run rebuild
// Потрібна після зміни логіки розрізання (напр. по добах) - таблиця похідна, дані не втрачаються.
import { config } from './core/config.ts';
import { createPool, tx } from './core/db.ts';
import { migrate } from './migrate.ts';
import { rebuildPeriods } from './sync/sync.ts';

const db = createPool(config.databaseUrl);
await migrate(db);

const result = await db.query('select id from alerts');
const ids = result.rows.map((row) => row.id);
await tx(db, (client) => rebuildPeriods(client, ids));

const total = await db.query('select count(*)::int as n from alert_periods');
console.log(`rebuilt: ${ids.length} alerts -> ${total.rows[0].n} periods`);
await db.end();
