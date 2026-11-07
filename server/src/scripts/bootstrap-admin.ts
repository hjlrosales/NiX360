import { loadConfig } from '../config.ts';
import { migrate, openDatabase } from '../db/sqlite.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { nowIso } from '../config.ts';
import { getRow, run } from '../db/sqlite.ts';
import { randomUUID } from 'node:crypto';

/**
 * One-time first-admin bootstrap. There are no shipped default credentials:
 * the password must be supplied explicitly through the environment.
 *
 *   NIX_ADMIN_LOGIN=owner NIX_ADMIN_PASSWORD='...' npm run bootstrap-admin
 */
const config = loadConfig();
const login = (process.env.NIX_ADMIN_LOGIN ?? '').trim().toLowerCase();
const displayName = (process.env.NIX_ADMIN_DISPLAY_NAME ?? login).trim();
const password = process.env.NIX_ADMIN_PASSWORD ?? '';
const force = process.argv.includes('--force');

if (!/^[a-z0-9._-]{3,64}$/.test(login)) {
  console.error('NIX_ADMIN_LOGIN must be 3-64 characters of a-z, 0-9, dot, underscore or dash.');
  process.exit(1);
}
const problem = passwordProblem(password);
if (problem) {
  console.error(`${problem}. Set NIX_ADMIN_PASSWORD to a strong password.`);
  process.exit(1);
}

const db = openDatabase(config.dbPath);
migrate(db);

const adminCount = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
if (Number(adminCount?.count ?? 0) > 0 && !force) {
  console.error('An administrator already exists. Re-run with --force to add another admin account.');
  process.exit(1);
}

const existing = getRow<{ id: string }>(db, 'SELECT id FROM users WHERE login = ?', login);
const passwordHash = await hashPassword(password);
const now = nowIso();

if (existing) {
  run(db, 'UPDATE users SET password_hash = ?, role = ?, enabled = 1, updated_at = ? WHERE id = ?', passwordHash, 'admin', now, existing.id);
  console.log(`Updated existing account "${login}" as administrator.`);
} else {
  run(
    db,
    'INSERT INTO users (id, login, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    randomUUID(),
    login,
    displayName,
    passwordHash,
    'admin',
    now,
    now,
  );
  console.log(`Created administrator "${login}".`);
}
db.close();
