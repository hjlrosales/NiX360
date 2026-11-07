import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { migrate, openDatabase } from './db/sqlite.ts';
import { syncConfiguredRoots } from './media/scan.ts';
import { buildApp } from './app.ts';
import { runWorker } from './jobs/worker.ts';
import { syncConfiguredOwner } from './auth/configured-owner.ts';

const config = loadConfig();
const isWorker = process.argv.includes('--worker');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.derivativesDir, { recursive: true });
fs.mkdirSync(config.tempDir, { recursive: true });

const db = openDatabase(config.dbPath);
const applied = migrate(db);
syncConfiguredRoots(db, config.roots);

if (!isWorker && config.configuredOwner) {
  const result = await syncConfiguredOwner(db, config.configuredOwner);
  console.log(`[nix360] configured owner ${result}: ${config.configuredOwner.login}`);
}

const abortController = new AbortController();

async function shutdown(signal: string): Promise<void> {
  if (abortController.signal.aborted) return;
  console.log(`[nix360] ${signal} received, shutting down`);
  abortController.abort();
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

if (isWorker) {
  console.log(
    `[nix360] worker starting (db=${config.dbPath}, roots=${config.roots.length}, applied migrations=${applied.length})`,
  );
  await runWorker({
    db,
    config,
    signal: abortController.signal,
    log: (message) => console.log(`[nix360] ${message}`),
  });
  db.close();
  console.log('[nix360] worker stopped');
  process.exit(0);
} else {
  const app = await buildApp({ db, config });
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`[nix360] api listening on http://${config.host}:${config.port} (migrations applied: ${applied.length})`);
  } catch (error) {
    console.error('[nix360] failed to start', error);
    process.exit(1);
  }

  abortController.signal.addEventListener('abort', () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
