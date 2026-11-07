import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { createTestContext, createUser, login, TEST_PASSWORD, type TestContext } from './helpers.ts';
import {
  RENDITION_PROFILES,
  needsRendition,
  renditionDimensions,
  sdrColorFilter,
  sphereFrameProblem,
} from '../src/media/rendition.ts';
import { displayDimensions, hdrKind, rotationDegrees } from '../src/media/probe.ts';
import { scanRoot } from '../src/media/scan.ts';
import { runWorker } from '../src/jobs/worker.ts';
import { getRow, getRows, run } from '../src/db/sqlite.ts';

async function drainQueue(ctx: TestContext): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await runWorker({
      db: ctx.db,
      config: ctx.config,
      signal: new AbortController().signal,
      once: true,
      log: () => {},
    });
  }
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('video rendition pipeline', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('keeps profile bounds, sphere geometry and even dimensions', () => {
    assert.deepEqual(renditionDimensions(3840, 2160, 'flat'), { width: 1920, height: 1080 });
    assert.deepEqual(renditionDimensions(1920, 960, 'equirectangular'), { width: 1920, height: 960 });
    assert.deepEqual(renditionDimensions(3840, 1920, 'equirectangular'), { width: 2160, height: 1080 });
    assert.deepEqual(renditionDimensions(1080, 1920, 'flat'), { width: 608, height: 1080 });
    assert.deepEqual(renditionDimensions(640, 360, 'flat'), { width: 640, height: 360 }, 'no upscaling');

    const saver = RENDITION_PROFILES['h264-720-v1']!;
    assert.deepEqual(renditionDimensions(3840, 2160, 'flat', saver), { width: 1280, height: 720 });
    assert.deepEqual(
      renditionDimensions(5760, 2880, 'equirectangular', saver),
      { width: 1440, height: 720 },
      'a sphere keeps 2:1 inside the smaller profile',
    );
    assert.equal(needsRendition(1920, 1080, 'flat', saver), true);
    assert.equal(needsRendition(1280, 720, 'flat', saver), false);
    assert.equal(needsRendition(1440, 720, 'equirectangular', saver), false);

    assert.equal(sphereFrameProblem(2160, 1080), null);
    assert.equal(sphereFrameProblem(1920, 960), null);
    assert.match(sphereFrameProblem(1920, 1080) ?? '', /2:1/, 'a 16:9 re-encode is refused');
    assert.match(sphereFrameProblem(0, 0) ?? '', /no usable frame size/);

    assert.equal(hdrKind('smpte2084', 'bt2020'), 'pq');
    assert.equal(hdrKind('arib-std-b67', 'bt2020'), 'hlg');
    assert.equal(hdrKind('bt709', 'bt2020'), 'wide_gamut', 'BT.2020 primaries need converting');
    assert.equal(hdrKind(null, null), null, 'bit depth alone is not evidence of HDR');
    assert.equal(hdrKind('bt709', 'bt709'), null);
    assert.equal(sdrColorFilter(null), null);
    assert.match(sdrColorFilter('pq') ?? '', /tonemap=hable/);
    assert.match(sdrColorFilter('hlg') ?? '', /tonemap=hable/);
    assert.match(sdrColorFilter('wide_gamut') ?? '', /zscale=p=bt709/);
    assert.doesNotMatch(sdrColorFilter('wide_gamut') ?? '', /tonemap/, 'SDR wide gamut is not tone-mapped');
  });

  it('normalizes display rotation and swaps quarter-turn dimensions', () => {
    assert.equal(rotationDegrees({}), 0);
    assert.equal(
      rotationDegrees({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }),
      90,
      'ffprobe may report a clockwise quarter turn as -90',
    );
    assert.equal(rotationDegrees({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 270 }] }), 90);
    assert.equal(rotationDegrees({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] }), 180);
    assert.equal(rotationDegrees({ tags: { rotate: '90' } }), 90);
    assert.deepEqual(displayDimensions(1920, 1080, 90), { width: 1080, height: 1920 });
    assert.deepEqual(displayDimensions(1920, 1080, 180), { width: 1920, height: 1080 });
    assert.deepEqual(displayDimensions(null, 1080, 90), { width: null, height: 1080 });
  });

  it('encodes a 10-bit HEVC original into a fast-start H.264 rendition', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }

    ctx = await createTestContext();
    const source = path.join(ctx.mediaRoot, 'clip.mp4');
    try {
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=10',
          '-t',
          '2.5',
          '-c:v',
          'libx265',
          '-pix_fmt',
          'yuv420p10le',
          '-x265-params',
          'log-level=error',
          '-y',
          source,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch {
      t.skip('this ffmpeg build cannot encode HEVC for the fixture');
      return;
    }

    const stats = await scanRoot(ctx.db, ctx.config, 'test');
    assert.equal(stats.filesAdded, 1);
    await drainQueue(ctx);

    const media = getRow<{ id: string; processing_state: string; projection: string; source_version: number }>(
      ctx.db,
      `SELECT id, processing_state, projection, source_version FROM media WHERE rel_path = 'clip.mp4'`,
    );
    assert.ok(media);
    assert.equal(media.processing_state, 'ready', 'rendition completion makes the item ready');

    const derivative = getRow<{ storage_key: string; width: number; height: number }>(
      ctx.db,
      `SELECT storage_key, width, height FROM derivatives
        WHERE media_id = ? AND kind = 'video' AND state = 'ready'`,
      media.id,
    );
    assert.ok(derivative, 'a video derivative row was recorded');
    assert.equal(derivative.width, 320);
    assert.equal(derivative.height, 180);

    const file = path.join(ctx.config.derivativesDir, derivative.storage_key);
    assert.ok(fs.existsSync(file));

    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_streams', file],
        { encoding: 'utf8', windowsHide: true },
      ),
    ) as { streams: { codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number }[] };
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video?.pix_fmt, 'yuv420p');

    const head = fs.readFileSync(file).subarray(0, 256 * 1024);
    const moov = head.indexOf('moov');
    const mdat = head.indexOf('mdat');
    assert.ok(moov !== -1, 'moov atom is present');
    assert.ok(mdat === -1 || moov < mdat, 'moov precedes mdat (fast start)');

    await createUser(ctx.db, 'viewer', TEST_PASSWORD);
    const cookie = await login(ctx.app, 'viewer');

    const unauth = await ctx.app.inject({ method: 'GET', url: `/api/media/${media.id}/rendition` });
    assert.equal(unauth.statusCode, 401);

    const ranged = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}/rendition`,
      headers: { range: 'bytes=0-99' },
      cookies: { nix_session: cookie },
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['content-type'], 'video/mp4');
    assert.equal(ranged.rawPayload.length, 100);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/${media.id}`,
      cookies: { nix_session: cookie },
    });
    const detailBody = detail.json() as {
      renditionUrl: string | null;
      playback: { kind: string } | null;
      playbackOptions: { kind: string; profile: string | null }[];
    };
    assert.equal(detailBody.renditionUrl, `/api/media/${media.id}/rendition?profile=h264-1080-v1`);
    assert.deepEqual(
      detailBody.playbackOptions.map((option) => option.kind),
      ['rendition'],
      'a small incompatible source gets only the standard rendition',
    );
    assert.equal(detailBody.playback?.kind, 'rendition');

    const jobs = getRows<{ kind: string; status: string }>(ctx.db, 'SELECT kind, status FROM jobs');
    assert.ok(jobs.some((job) => job.kind === 'video_rendition' && job.status === 'succeeded'));
    assert.ok(!jobs.some((job) => job.status === 'failed'), 'no job failed');
  });

  it('tone-maps an HDR source into a tagged SDR rendition', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }

    const local = await createTestContext();
    try {
      const source = path.join(local.mediaRoot, 'hlg.mp4');
      try {
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=320x180:rate=10',
            '-t',
            '2',
            '-c:v',
            'libx265',
            '-pix_fmt',
            'yuv420p10le',
            '-x265-params',
            'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
            '-color_primaries',
            'bt2020',
            '-color_trc',
            'arib-std-b67',
            '-colorspace',
            'bt2020nc',
            '-y',
            source,
          ],
          { stdio: 'ignore', windowsHide: true },
        );
      } catch {
        t.skip('this ffmpeg build cannot create an HLG fixture');
        return;
      }
      const fixture = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', source], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      ) as { streams: { color_transfer?: string }[] };
      if (fixture.streams[0]?.color_transfer !== 'arib-std-b67') {
        t.skip('this ffmpeg build did not retain the HLG transfer tag');
        return;
      }

      await scanRoot(local.db, local.config, 'test');
      await drainQueue(local);

      const media = getRow<{
        id: string;
        direct_play: number;
        bit_depth: number | null;
        transfer: string | null;
        primaries: string | null;
      }>(
        local.db,
        `SELECT m.id, md.direct_play, md.bit_depth, md.color_transfer AS transfer, md.color_primaries AS primaries
           FROM media m JOIN media_metadata md ON md.media_id = m.id WHERE m.rel_path = 'hlg.mp4'`,
      );
      assert.ok(media, 'the HDR fixture was catalogued');
      assert.equal(media.direct_play, 0, 'HDR is never advertised as direct-play');
      assert.equal(media.bit_depth, 10);
      assert.equal(media.transfer, 'arib-std-b67');
      assert.equal(media.primaries, 'bt2020');

      const derivative = getRow<{ storage_key: string; width: number; height: number }>(
        local.db,
        `SELECT storage_key, width, height FROM derivatives
          WHERE media_id = ? AND kind = 'video' AND state = 'ready'`,
        media.id,
      );
      assert.ok(derivative, 'the SDR rendition was published');
      const output = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-print_format', 'json', '-show_streams', path.join(local.config.derivativesDir, derivative.storage_key)],
          { encoding: 'utf8', windowsHide: true },
        ),
      ) as { streams: { codec_type: string; pix_fmt?: string; color_transfer?: string; color_primaries?: string }[] };
      const video = output.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(video?.pix_fmt, 'yuv420p');
      assert.equal(video?.color_transfer, 'bt709');
      assert.equal(video?.color_primaries, 'bt709');

      await createUser(local.db, 'viewer', TEST_PASSWORD);
      const cookie = await login(local.app, 'viewer');
      const detail = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}`,
        cookies: { nix_session: cookie },
      });
      const body = detail.json() as {
        metadata: {
          bitDepth: number | null;
          colorTransfer: string | null;
          colorPrimaries: string | null;
          hdr: string | null;
        } | null;
        playbackOptions: { kind: string; label: string; toneMapped: boolean }[];
      };
      assert.equal(body.metadata?.hdr, 'hlg');
      assert.equal(body.metadata?.colorTransfer, 'arib-std-b67');
      assert.equal(body.metadata?.colorPrimaries, 'bt2020');
      assert.deepEqual(body.playbackOptions.map((option) => option.kind), ['rendition']);
      assert.equal(body.playbackOptions[0]?.toneMapped, true);
      assert.match(body.playbackOptions[0]?.label ?? '', /HDR → SDR/);

      const jobs = getRows<{ status: string }>(local.db, 'SELECT status FROM jobs');
      assert.ok(!jobs.some((job) => job.status === 'failed'), 'no job failed');
    } finally {
      await local.cleanup();
    }
  });

  it('offers a data-saver rendition beside a direct-play original', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }

    const local = await createTestContext();
    try {
      const source = path.join(local.mediaRoot, 'wide.mp4');
      try {
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=1600x900:rate=10',
            '-t',
            '1.5',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-y',
            source,
          ],
          { stdio: 'ignore', windowsHide: true },
        );
      } catch {
        t.skip('this ffmpeg build cannot encode H.264 for the fixture');
        return;
      }

      await scanRoot(local.db, local.config, 'test');
      await drainQueue(local);

      const media = getRow<{ id: string; direct_play: number }>(
        local.db,
        `SELECT m.id, md.direct_play FROM media m
           JOIN media_metadata md ON md.media_id = m.id WHERE m.rel_path = 'wide.mp4'`,
      );
      assert.ok(media, 'the fixture was catalogued');
      assert.equal(media.direct_play, 1, 'the fixture is direct-playable');

      const renditions = getRows<{ recipe_version: string; width: number; height: number }>(
        local.db,
        `SELECT recipe_version, width, height FROM derivatives
          WHERE media_id = ? AND kind = 'video' AND state = 'ready' ORDER BY recipe_version`,
        media.id,
      );
      assert.deepEqual(
        renditions.map((row) => row.recipe_version),
        ['h264-720-v1'],
        'only profiles that downscale are encoded',
      );
      assert.equal(renditions[0]!.width, 1280);
      assert.equal(renditions[0]!.height, 720);

      await createUser(local.db, 'viewer', TEST_PASSWORD);
      const cookie = await login(local.app, 'viewer');

      const detail = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}`,
        cookies: { nix_session: cookie },
      });
      const body = detail.json() as {
        playback: { kind: string } | null;
        playbackOptions: {
          kind: string;
          profile: string | null;
          url: string;
          width: number | null;
          height: number | null;
        }[];
      };
      assert.deepEqual(
        body.playbackOptions.map((option) => option.kind),
        ['original', 'rendition'],
        'the original and the prepared data saver are both selectable',
      );
      assert.equal(body.playback?.kind, 'original', 'the untouched original is the default');
      const saver = body.playbackOptions[1]!;
      assert.equal(saver.profile, 'h264-720-v1');
      assert.equal(saver.width, 1280);
      assert.equal(saver.height, 720);
      assert.equal(saver.url, `/api/media/${media.id}/rendition?profile=h264-720-v1`);

      // A spherical classification travels with every representation, so the
      // client never has to guess that a rendition is still a 360° frame.
      run(local.db, `UPDATE media SET projection = 'equirectangular' WHERE id = ?`, media.id);
      const sphere = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}`,
        cookies: { nix_session: cookie },
      });
      const sphereBody = sphere.json() as {
        playbackOptions: { projection: string; spherical: boolean }[];
      };
      assert.ok(sphereBody.playbackOptions.length > 0);
      assert.ok(
        sphereBody.playbackOptions.every(
          (option) => option.projection === 'equirectangular' && option.spherical,
        ),
        'every representation of a spherical source is labeled as such',
      );

      const ranged = await local.app.inject({
        method: 'GET',
        url: saver.url,
        headers: { range: 'bytes=0-99' },
        cookies: { nix_session: cookie },
      });
      assert.equal(ranged.statusCode, 206);
      assert.equal(ranged.headers['content-type'], 'video/mp4');
      assert.equal(ranged.rawPayload.length, 100);

      const unencoded = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}/rendition?profile=h264-1080-v1`,
        cookies: { nix_session: cookie },
      });
      assert.equal(unencoded.statusCode, 404, 'an unencoded profile is not served');

      const invalid = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}/rendition?profile=nope`,
        cookies: { nix_session: cookie },
      });
      assert.equal(invalid.statusCode, 400);

      const original = await local.app.inject({
        method: 'GET',
        url: `/api/media/${media.id}/original`,
        cookies: { nix_session: cookie },
      });
      assert.equal(original.statusCode, 200);

      const jobs = getRows<{ status: string }>(local.db, 'SELECT status FROM jobs');
      assert.ok(!jobs.some((job) => job.status === 'failed'), 'no job failed');
    } finally {
      await local.cleanup();
    }
  });

  it('applies a portrait display rotation and caps frame rate at 30', async (t) => {
    if (!hasFfmpeg()) {
      t.skip('ffmpeg is not installed in this environment');
      return;
    }

    const local = await createTestContext();
    try {
      const flat = path.join(local.mediaRoot, 'flat.mp4');
      const portrait = path.join(local.mediaRoot, 'portrait.mp4');
      try {
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=1600x900:rate=60',
            '-t',
            '1.5',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-y',
            flat,
          ],
          { stdio: 'ignore', windowsHide: true },
        );
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-display_rotation',
            '90',
            '-i',
            flat,
            '-c',
            'copy',
            '-y',
            portrait,
          ],
          { stdio: 'ignore', windowsHide: true },
        );
        const fixture = JSON.parse(
          execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', portrait], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        ) as { streams: { side_data_list?: { side_data_type?: string; rotation?: number }[] }[] };
        const hasRotation = (fixture.streams ?? []).some((stream) =>
          (stream.side_data_list ?? []).some(
            (entry) => /display matrix/i.test(entry.side_data_type ?? '') && entry.rotation !== undefined,
          ),
        );
        if (!hasRotation) {
          t.skip('this ffmpeg build did not record a display matrix');
          return;
        }
      } catch {
        t.skip('this ffmpeg build cannot create the rotated fixture');
        return;
      }
      // Keep the rotated copy only, so the scan sees one fixture.
      fs.rmSync(flat, { force: true });

      await scanRoot(local.db, local.config, 'test');
      await drainQueue(local);

      const media = getRow<{ id: string; width: number; height: number; rotation: number }>(
        local.db,
        `SELECT m.id, md.width, md.height, md.rotation_degrees AS rotation
           FROM media m JOIN media_metadata md ON md.media_id = m.id
          WHERE m.rel_path = 'portrait.mp4'`,
      );
      assert.ok(media);
      assert.equal(media.rotation, 90);
      assert.equal(media.width, 900, 'display width comes from the coded height');
      assert.equal(media.height, 1600);

      const derivative = getRow<{ storage_key: string; width: number; height: number }>(
        local.db,
        `SELECT storage_key, width, height FROM derivatives
          WHERE media_id = ? AND kind = 'video' AND state = 'ready'`,
        media.id,
      );
      assert.ok(derivative);
      assert.equal(derivative.width, 406, 'the portrait frame is fitted to the flat bounds');
      assert.equal(derivative.height, 720);

      const file = path.join(local.config.derivativesDir, derivative.storage_key);
      const output = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      ) as { streams: { codec_type: string; avg_frame_rate?: string; width?: number; height?: number }[] };
      const video = output.streams.find((stream) => stream.codec_type === 'video');
      assert.ok(video);
      assert.equal(video.width, 406, 'FFmpeg autorotated before scaling');
      assert.equal(video.height, 720);
      assert.equal(
        output.streams.filter((stream) => stream.codec_type === 'audio').length,
        0,
        'a silent source stays silent',
      );
      const [numerator, denominator] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
      assert.ok(
        Math.abs(numerator! / (denominator || 1) - 30) < 0.01,
        `a 60 fps source is capped at 30 fps (got ${video.avg_frame_rate})`,
      );
    } finally {
      await local.cleanup();
    }
  });
});
