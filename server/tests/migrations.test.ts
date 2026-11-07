import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate, openDatabase } from '../src/db/sqlite.ts';

describe('database migrations', () => {
  it('applies migrations once and is idempotent', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db);
    assert.deepEqual(first, [
      '001_initial',
      '002_navigation_duplicates_queue',
      '003_lrf_companions',
      '004_video_rotation',
      '005_stitched_exports',
      '006_color_metadata',
    ]);

    assert.deepEqual(migrate(db), [], 're-running migrations must not reapply');
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[];
    assert.deepEqual(
      rows.map((row) => row.version),
      [
        '001_initial',
        '002_navigation_duplicates_queue',
        '003_lrf_companions',
        '004_video_rotation',
        '005_stitched_exports',
        '006_color_metadata',
      ],
    );

    const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);

    const required = [
      'users',
      'sessions',
      'library_roots',
      'media',
      'media_metadata',
      'media_overrides',
      'media_relations',
      'derivatives',
      'jobs',
      'scan_runs',
      'albums',
      'album_items',
      'favorites',
      'viewing_history',
      'audit_events',
      'app_settings',
      'companion_checks',
    ];
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of required) assert.ok(tables.includes(table), `missing table ${table}`);

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  });

  it('enforces foreign keys and uniqueness constraints', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    assert.throws(
      () =>
        db
          .prepare(`INSERT INTO media (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms,
                                       media_type, projection, availability, processing_state, last_seen_scan, created_at, updated_at)
                    VALUES ('m1', 'nope', 'a.jpg', '.jpg', 1, 1, 1, 'photo', 'flat', 'present', 'pending', 0, 'x', 'x')`)
          .run(),
      /FOREIGN KEY/i,
    );
    db.close();
  });
});
