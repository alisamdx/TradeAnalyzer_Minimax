import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { WatchlistService } from '../src/main/services/watchlist-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

export function makeService() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const service = new WatchlistService(db);
  service.ensureDefault();
  return { db, service };
}
