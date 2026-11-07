import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { backupDatabase } from '../db/backup.ts';
import { openDatabase } from '../db/sqlite.ts';

/**
 * Writes a consistent, verified copy of the catalog while the API and worker
 * keep running. The destination is explicit so an operator can place it on
 * backup storage outside the data volume:
 *
 *   npm run backup -- --out /volume1/docker/nix360/backups/library-2026-11-05.sqlite
 */
function usage(): never {
  console.error('Usage: npm run backup -- --out <path-to-backup.sqlite> [--force]');
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex === -1 ? null : args[outIndex + 1];
if (!out || out.startsWith('--')) usage();

const force = args.includes('--force');
const destination = path.resolve(out);
if (fs.existsSync(destination) && !force) {
  console.error(`Refusing to overwrite ${destination}. Pass --force to replace it.`);
  process.exit(1);
}

const config = loadConfig();
if (!fs.existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run npm run migrate first.`);
  process.exit(1);
}

if (force) fs.rmSync(destination, { force: true });

const db = openDatabase(config.dbPath);
try {
  const result = await backupDatabase(db, destination);
  console.log(
    `[nix360] backup written: ${result.path} (${result.bytes} bytes, ${result.tables} tables, schema version ${result.migrations})`,
  );
} finally {
  db.close();
}
