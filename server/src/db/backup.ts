import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

export type BackupResult = {
  path: string;
  bytes: number;
  tables: number;
  migrations: number;
};

export type BackupVerification = {
  tables: number;
  migrations: number;
};

/**
 * Checks that a file is a readable database with an intact page structure,
 * satisfied foreign keys and an applied migration history. Used on the
 * temporary copy before it is published, so a crashed backup can never
 * replace a good one with a partial file.
 */
export function verifyBackup(file: string): BackupVerification {
  if (!fs.existsSync(file)) throw new Error(`Backup file is missing: ${file}`);
  const db = new DatabaseSync(file);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`Backup failed its integrity check: ${integrity?.integrity_check ?? 'no result'}`);
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(`Backup contains ${violations.length} foreign-key violation(s)`);
    }
    const tables = db
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .get() as { count: number };
    const migrations = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    return { tables: Number(tables.count), migrations: Number(migrations.count) };
  } finally {
    db.close();
  }
}

/**
 * Consistent snapshot of a live WAL-mode database using SQLite's online
 * backup API, which copies committed pages without blocking writers for the
 * duration. The output is written beside the destination, verified, and only
 * then renamed into place. Existing files are never overwritten implicitly:
 * an operator must pass `--force` to the CLI first.
 */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<BackupResult> {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved)) throw new Error(`Backup destination already exists: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const temporary = `${resolved}.partial-${process.pid}-${Date.now()}`;
  try {
    await sqliteBackup(db, temporary);
    const verification = verifyBackup(temporary);
    try {
      fs.renameSync(temporary, resolved);
    } catch (error) {
      // A destination on another filesystem cannot be renamed into place.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      fs.copyFileSync(temporary, resolved);
      fs.rmSync(temporary, { force: true });
    }
    return { path: resolved, bytes: fs.statSync(resolved).size, ...verification };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
