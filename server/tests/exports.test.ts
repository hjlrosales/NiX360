import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import { getRow, run } from '../src/db/sqlite.ts';
import { nowIso } from '../src/config.ts';
import { linkExport, linkedExport } from '../src/media/exports.ts';

type MediaOptions = {
  id: string;
  relPath: string;
  extension: string;
  projection: string;
  state?: string;
  availability?: string;
  version?: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  directPlay?: boolean;
};

function insertMedia(ctx: TestContext, options: MediaOptions): void {
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO media
       (id, root_id, rel_path, extension, source_version, size_bytes, mtime_ms, media_type,
        projection, availability, processing_state, created_at, updated_at)
     VALUES (?, 'test', ?, ?, ?, 1024, 1, 'video', ?, ?, ?, ?, ?)`,
    options.id,
    options.relPath,
    options.extension,
    options.version ?? 1,
    options.projection,
    options.availability ?? 'present',
    options.state ?? 'ready',
    now,
    now,
  );
  run(
    ctx.db,
    `INSERT INTO media_metadata
       (media_id, width, height, duration_ms, direct_play, metadata_source, projection_source)
     VALUES (?, ?, ?, ?, ?, 'ffprobe', 'metadata')`,
    options.id,
    options.width ?? null,
    options.height ?? null,
    options.durationMs ?? null,
    options.directPlay ? 1 : 0,
  );
}

type Detail = {
  experience: { state: string };
  originalConversionRequired: boolean;
  playbackOptions: { kind: string; label: string; url: string; spherical: boolean }[];
  export: { mediaId: string; playable: boolean; width: number | null } | null;
};

describe('full-sphere export linking', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('validates the relationship and exposes the export as playback', async () => {
    ctx = await createTestContext();
    insertMedia(ctx, {
      id: 'raw',
      relPath: 'CAM_0001.OSV',
      extension: '.OSV',
      projection: 'dual_fisheye',
      state: 'unsupported',
    });
    insertMedia(ctx, {
      id: 'flat',
      relPath: 'clip.mp4',
      extension: '.mp4',
      projection: 'flat',
      directPlay: true,
    });
    insertMedia(ctx, {
      id: 'sphere',
      relPath: 'DJI_export.mp4',
      extension: '.mp4',
      projection: 'equirectangular',
      width: 3840,
      height: 1920,
      durationMs: 12_000,
      directPlay: true,
    });

    assert.deepEqual(linkExport(ctx.db, 'raw', 'raw', 'admin'), { ok: false, error: 'self_link' });
    assert.deepEqual(linkExport(ctx.db, 'raw', 'missing', 'admin'), { ok: false, error: 'not_found' });
    assert.deepEqual(linkExport(ctx.db, 'flat', 'sphere', 'admin'), { ok: false, error: 'not_raw_original' });
    assert.deepEqual(linkExport(ctx.db, 'raw', 'flat', 'admin'), { ok: false, error: 'not_equirectangular' });

    assert.deepEqual(linkExport(ctx.db, 'raw', 'sphere', 'admin'), { ok: true });
    const link = linkedExport(ctx.db, 'raw');
    assert.ok(link);
    assert.equal(link.mediaId, 'sphere');
    assert.equal(link.width, 3840);
    assert.equal(link.projection, 'equirectangular');
    const provenance = link.provenance as { policyVersion: number; actorId: string };
    assert.equal(provenance.actorId, 'admin');
    assert.equal(provenance.policyVersion, 1);

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const detail = await ctx.app.inject({
      method: 'GET',
      url: '/api/media/raw',
      cookies: { nix_session: cookie },
    });
    assert.equal(detail.statusCode, 200);
    const body = detail.json() as Detail;
    assert.equal(body.playbackOptions[0]?.kind, 'export', 'the stitched export is the best representation');
    assert.equal(body.playbackOptions[0]?.label, 'Spherical export');
    assert.equal(body.playbackOptions[0]?.spherical, true);
    assert.equal(body.playbackOptions[0]?.url, '/api/media/sphere/original');
    assert.equal(body.experience.state, 'ready', 'a linked export makes the recording playable');
    assert.equal(body.originalConversionRequired, true, 'the raw original still needs conversion');
    assert.equal(body.export?.mediaId, 'sphere');
    assert.equal(body.export?.playable, true);

    // An HEVC export has no direct-play path; its ready rendition is offered instead.
    run(ctx.db, `UPDATE media_metadata SET direct_play = 0 WHERE media_id = 'sphere'`);
    const stamp = nowIso();
    run(
      ctx.db,
      `INSERT INTO derivatives
         (id, media_id, source_version, recipe_version, kind, storage_key, bytes, width, height, state, created_at, updated_at)
       VALUES ('sphere-rendition', 'sphere', 1, 'h264-1080-v1', 'video',
               'sphere/v1/h264-1080-v1/rendition.mp4', 1024, 2160, 1080, 'ready', ?, ?)`,
      stamp,
      stamp,
    );
    const transcoded = await ctx.app.inject({
      method: 'GET',
      url: '/api/media/raw',
      cookies: { nix_session: cookie },
    });
    const transcodedBody = transcoded.json() as Detail;
    assert.equal(transcodedBody.playbackOptions[0]?.kind, 'export');
    assert.equal(
      transcodedBody.playbackOptions[0]?.url,
      '/api/media/sphere/rendition?profile=h264-1080-v1',
      'a prepared export rendition is playable',
    );
    assert.equal(transcodedBody.export?.playable, true);
  });

  it('requires an administrator and audits link and unlink', async () => {
    await createUser(ctx.db, 'owner', TEST_PASSWORD, 'admin');
    const viewerCookie = await login(ctx.app, 'viewer');
    const adminCookie = await login(ctx.app, 'owner');

    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/exports',
      payload: { action: 'link', sourceId: 'raw', exportId: 'sphere' },
      cookies: { nix_session: viewerCookie },
    });
    assert.ok([401, 403].includes(forbidden.statusCode), 'a viewer cannot link exports');

    // Re-link through the administrator endpoint so both decisions are audited.
    const relink = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/exports',
      payload: { action: 'link', sourceId: 'raw', exportId: 'sphere' },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(relink.statusCode, 200);

    const listing = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/exports',
      cookies: { nix_session: adminCookie },
    });
    assert.equal(listing.statusCode, 200);
    const listed = listing.json() as {
      relations: { sourceId: string; mediaId: string; fileName: string }[];
      originals: { id: string }[];
      candidates: { id: string }[];
    };
    assert.equal(listed.relations[0]?.sourceId, 'raw');
    assert.equal(listed.relations[0]?.mediaId, 'sphere');
    assert.deepEqual(listed.originals.map((item) => item.id), ['raw']);
    assert.deepEqual(listed.candidates.map((item) => item.id), ['sphere']);

    const unlink = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/exports',
      payload: { action: 'unlink', sourceId: 'raw', exportId: 'sphere' },
      cookies: { nix_session: adminCookie },
    });
    assert.equal(unlink.statusCode, 200);
    assert.equal(linkedExport(ctx.db, 'raw'), null);

    const unlinked = await ctx.app.inject({
      method: 'GET',
      url: '/api/media/raw',
      cookies: { nix_session: viewerCookie },
    });
    const body = unlinked.json() as Detail;
    assert.equal(body.playbackOptions.length, 0);
    assert.equal(body.experience.state, 'conversion_required');
    assert.equal(body.export, null);

    const events = getRow<{ count: number }>(
      ctx.db,
      `SELECT COUNT(*) AS count FROM audit_events WHERE action IN ('admin.export_linked', 'admin.export_unlinked')`,
    );
    assert.equal(Number(events?.count ?? 0), 2, 'both decisions are audited');
  });

  it('suspends the link when either file changes and relinking records new versions', async () => {
    assert.ok(linkExport(ctx.db, 'raw', 'sphere', 'owner').ok);
    assert.ok(linkedExport(ctx.db, 'raw'));

    run(ctx.db, `UPDATE media SET source_version = 2 WHERE id = 'sphere'`);
    assert.equal(linkedExport(ctx.db, 'raw'), null, 'a changed export suspends the selection');

    await createUser(ctx.db, 'viewer2', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer2');
    const detail = await ctx.app.inject({
      method: 'GET',
      url: '/api/media/raw',
      cookies: { nix_session: cookie },
    });
    const body = detail.json() as Detail;
    assert.equal(body.playbackOptions.length, 0);
    assert.equal(body.experience.state, 'conversion_required');

    assert.ok(linkExport(ctx.db, 'raw', 'sphere', 'owner').ok, 're-confirming records the new version');
    const relinked = linkedExport(ctx.db, 'raw');
    assert.equal(relinked?.sourceVersion, 2);

    run(ctx.db, `UPDATE media SET source_version = 3 WHERE id = 'raw'`);
    assert.equal(linkedExport(ctx.db, 'raw'), null, 'a changed original suspends the selection too');
  });
});
