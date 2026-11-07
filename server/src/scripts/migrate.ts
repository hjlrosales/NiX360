import { loadConfig } from '../config.ts';
import { migrate, openDatabase } from '../db/sqlite.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const applied = migrate(db);
if (applied.length === 0) {
  console.log(`No pending migrations (database: ${config.dbPath})`);
} else {
  console.log(`Applied migrations: ${applied.join(', ')} (database: ${config.dbPath})`);
}
db.close();
