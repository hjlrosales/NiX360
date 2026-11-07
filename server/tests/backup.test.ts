import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTestContext, createUser, TEST_PASSWORD } from './helpers.ts';
import { backupDatabase, verifyBackup } from '../src/db/backup.ts';
import { getRow, migrate, openDatabase, run } from '../src/db/sqlite.ts';
import { nowIso } from '../src/config.ts';
import { canonicalMediaId, companionPreview } from '../src/media/companions.ts';

const NOW = nowIso();

/** Seeds a catalog, a confirmed companion, user state and catalog overrides. */
function seed(ctx: Awaited<ReturnType<typeof createTestContext>>, userId: string): void {
  const media = [
    ['osv-1', 'DCIM/CAM_0100.OSV', '.osv', 'video', 'dual_fisheye', 'unsupported'],
    ['lrf-1', 'DCIM/CAM_0100.LRF', '.lrf', 'video', 'unknown', 'ready'],
    ['photo-1', 'DCIM/sphere.jpg', '.jpg', 'photo', 'equirectangular', 'ready'],
  ];
  for (const [id, relPath, extension, mediaType, projection, state] of media) {
    run(
      ctx.db,
      `INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms,
                          media_type, projection, availability, processing_state, capture_date,
                          last_seen_scan, created_at, updated_at)
       VALUES (?, 'test', ?, ?, 1, 2048, 1, ?, ?, 'present', ?, ?, 1, ?, ?)`,
      id,
      relPath,
      extension,
      mediaType,
      projection,
      state,
      NOW,
      NOW,
      NOW,
    );
  }
  run(
    ctx.db,
    `INSERT INTO media_metadata (media_id, width, height, duration_ms, metadata_source, projection_source,
                                 direct_play, capture_date_certain, probed_at)
     VALUES ('lrf-1', 2048, 1024, 7168, 'ffprobe', 'unknown', 1, 0, ?)`,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO media_metadata (media_id, width, height, metadata_source, projection_source,
                                 direct_play, capture_date_certain, probed_at)
     VALUES ('photo-1', 15520, 7760, 'exiftool', 'metadata', 0, 1, ?)`,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO media_relations (id, source_media_id, related_media_id, relation_type, provenance,
                                  created_at, status, policy_version, source_version, related_version, updated_at)
     VALUES ('rel-1', 'osv-1', 'lrf-1', 'preview_companion', '{"policyVersion":1,"decidedBy":"auto"}',
             ?, 'confirmed', 1, 1, 1, ?)`,
    NOW,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO derivatives (id, media_id, source_version, recipe_version, kind, storage_key, bytes,
                              state, created_at, updated_at)
     VALUES ('der-1', 'photo-1', 1, 'pano-sq-v1', 'tiles', 'photo-1/v1/pano-sq-v1/manifest.json',
             3535092, 'ready', ?, ?)`,
    NOW,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO media_overrides (media_id, title, display_date, projection, yaw_degrees, pitch_degrees,
                                  roll_degrees, updated_at)
     VALUES ('photo-1', 'Enclosure', '2026-11-05T10:00:00.000Z', 'equirectangular', 12, 34, 56, ?)`,
    NOW,
  );
  run(ctx.db, `INSERT INTO favorites (user_id, media_id, created_at) VALUES (?, 'osv-1', ?)`, userId, NOW);
  run(
    ctx.db,
    `INSERT INTO albums (id, owner_id, title, created_at, updated_at) VALUES ('album-1', ?, 'Trip', ?, ?)`,
    userId,
    NOW,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO album_items (album_id, media_id, position, added_at) VALUES ('album-1', 'osv-1', 0, ?)`,
    NOW,
  );
  run(
    ctx.db,
    `INSERT INTO viewing_history (user_id, media_id, last_viewed_at, position_seconds) VALUES (?, 'osv-1', ?, 42)`,
    userId,
    NOW,
  );
  run(ctx.db, `UPDATE app_settings SET value = 'true', updated_at = ? WHERE key = 'queue.paused'`, NOW);
}

describe('database backup and restore', () => {
  it('writes a consistent snapshot that restores catalog, relationships and user state', async (t) => {
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());
    const userId = await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    seed(ctx, userId);

    const destination = path.join(ctx.workspace, 'backups', 'library-2026-11-05.sqlite');
    const result = await backupDatabase(ctx.db, destination);

    assert.equal(result.path, destination);
    assert.ok(result.bytes > 0);
    assert.equal(result.migrations, 6);
    assert.ok(result.tables >= 17);
    assert.equal(fs.existsSync(`${destination}-wal`), false, 'the snapshot is self-contained');

    // A destination is never replaced implicitly.
    await assert.rejects(() => backupDatabase(ctx.db, destination), /already exists/);

    // Writing to the live database after the snapshot must not affect it.
    run(ctx.db, `INSERT INTO app_settings (key, value, updated_at) VALUES ('after.backup', '1', ?)`, NOW);

    const restoredPath = path.join(ctx.workspace, 'restore', 'library.sqlite');
    fs.mkdirSync(path.dirname(restoredPath), { recursive: true });
    fs.copyFileSync(destination, restoredPath);
    const restored = openDatabase(restoredPath);
    try {
      assert.deepEqual(migrate(restored), [], 'a restored backup needs no new migrations');
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(
        (restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
        'ok',
      );
      assert.equal(getRow<{ count: number }>(restored, 'SELECT COUNT(*) AS count FROM media')?.count, 3);
      assert.equal(
        getRow<{ count: number }>(restored, "SELECT COUNT(*) AS count FROM media WHERE availability = 'present'")
          ?.count,
        3,
        'availability survives the snapshot',
      );

      const relation = getRow<{ status: string; provenance: string }>(
        restored,
        'SELECT status, provenance FROM media_relations WHERE id = ?',
        'rel-1',
      );
      assert.equal(relation?.status, 'confirmed');
      assert.match(relation!.provenance, /decidedBy/);
      assert.equal(canonicalMediaId(restored, 'lrf-1'), 'osv-1', 'companion deep links still resolve');
      assert.equal(companionPreview(restored, 'osv-1')?.id, 'lrf-1', 'the preview source survives');

      assert.equal(
        getRow<{ count: number }>(restored, "SELECT COUNT(*) AS count FROM favorites WHERE media_id = 'osv-1'")
          ?.count,
        1,
      );
      assert.equal(
        getRow<{ media_id: string }>(restored, "SELECT media_id FROM album_items WHERE album_id = 'album-1'")
          ?.media_id,
        'osv-1',
      );
      assert.equal(
        getRow<{ position_seconds: number }>(
          restored,
          "SELECT position_seconds FROM viewing_history WHERE media_id = 'osv-1'",
        )?.position_seconds,
        42,
      );
      assert.equal(
        getRow<{ projection: string; yaw_degrees: number }>(
          restored,
          "SELECT projection, yaw_degrees FROM media_overrides WHERE media_id = 'photo-1'",
        )?.projection,
        'equirectangular',
      );
      assert.equal(
        getRow<{ storage_key: string }>(restored, "SELECT storage_key FROM derivatives WHERE id = 'der-1'")
          ?.storage_key,
        'photo-1/v1/pano-sq-v1/manifest.json',
      );
      assert.equal(
        getRow<{ value: string }>(restored, "SELECT value FROM app_settings WHERE key = 'queue.paused'")?.value,
        'true',
        'durable settings survive',
      );
      assert.equal(
        getRow<{ value: string }>(restored, "SELECT value FROM app_settings WHERE key = 'after.backup'"),
        undefined,
        'writes after the snapshot are not in the backup',
      );

      // The restored copy is a normal writable database for the next run.
      run(restored, `INSERT INTO app_settings (key, value, updated_at) VALUES ('restored', '1', ?)`, NOW);
      assert.equal(
        getRow<{ value: string }>(restored, "SELECT value FROM app_settings WHERE key = 'restored'")?.value,
        '1',
      );
    } finally {
      restored.close();
    }

    // The live database remains usable and its own snapshot still verifies.
    assert.equal(
      getRow<{ value: string }>(ctx.db, "SELECT value FROM app_settings WHERE key = 'after.backup'")?.value,
      '1',
    );
    assert.deepEqual(verifyBackup(destination), { tables: result.tables, migrations: 6 });
  });

  it('rejects a file that is not a database', async (t) => {
    const ctx = await createTestContext();
    t.after(async () => ctx.cleanup());
    const invalid = path.join(ctx.workspace, 'not-a-database.sqlite');
    fs.writeFileSync(invalid, 'this is not an SQLite database');
    assert.throws(() => verifyBackup(invalid), /not a database|integrity/i);
  });
});
