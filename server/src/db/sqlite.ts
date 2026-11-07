import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../config.ts';

export type SqlParam = string | number | null;

const migrationsDir = path.join(import.meta.dirname, 'migrations');

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/**
 * Applies every pending SQL migration exactly once, each inside its own
 * transaction. Versions are recorded so restarts and repeated deploys are
 * idempotent.
 */
export function migrate(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const appliedNow: string[] = [];
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed: ${(error as Error).message}`, { cause: error });
    }
    appliedNow.push(version);
  }
  return appliedNow;
}

export function getRow<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function getRows<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: SqlParam[]): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.changes);
}

let savepointCounter = 0;

/**
 * Savepoint-based transaction helper. Savepoints nest, so queue enqueue calls
 * can run inside a scan's per-file transaction without a nested-BEGIN error.
 * A top-level savepoint behaves as a normal transaction.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  savepointCounter += 1;
  const name = `nix_sp_${savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
