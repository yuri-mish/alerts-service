import { config, requireConfig } from './core/config.ts';
import { createPool } from './core/db.ts';
import { migrate } from './migrate.ts';
import { createFetcher } from './sync/alerts-api.ts';
import { createServer } from './http/server.ts';
import { startScheduler } from './sync/scheduler.ts';
import { log } from './core/log.ts';
import { setupTelegram } from './notify/telegram.ts';
import { startMonitor } from './notify/monitor.ts';

requireConfig('alertsToken', 'apiKey');

const db = createPool(config.databaseUrl);
await migrate(db);

const fetcher = createFetcher(config.alertsToken);
const telegram = await setupTelegram({
  botToken: config.telegramBotToken,
  chatId: config.telegramChatId,
  publicUrl: config.publicUrl,
});
const server = createServer({
  db,
  fetcher,
  adminKey: config.apiKey,
  rateLimitPerMin: config.rateLimitPerMin,
  telegram,
});
server.listen(config.port, config.host, () => {
  log.info('listening', { host: config.host, port: config.port, syncTime: config.syncTime, timeZone: config.timeZone });
});
const stopScheduler = startScheduler(db, fetcher, config.syncTime);

const stopMonitor = startMonitor(db, telegram, config.monitorBackupDir);

const shutdown = (sig: string) => {
  log.info('shutdown', { sig });
  stopScheduler();
  stopMonitor();
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
