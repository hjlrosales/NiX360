import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { nowIso } from '../config.ts';
import { getRow, getRows, run, transaction } from '../db/sqlite.ts';
import { PermanentJobError, sanitizeError } from '../jobs/errors.ts';
import { enqueue, type Job } from '../jobs/queue.ts';
import { hashMediaFile, recordContentHash } from '../media/hash.ts';
import {
  RENDITION_PROFILE_LIST,
  RENDITION_RECIPE,
  generateRendition,
  needsRendition,
  renditionProfile,
} from '../media/rendition.ts';
import { mediaFilePath } from '../media/paths.ts';
import { probeMediaFile } from '../media/probe.ts';
import { DJI_EXPORT_GUIDANCE } from '../media/experience.ts';
import { evaluateCompanionPair } from '../media/companions.ts';
import { scanRoot, type MediaRow } from '../media/scan.ts';
import { THUMBNAIL_RECIPE, generateDerivatives } from '../media/thumbnails.ts';
import { PANO_TILE_RECIPE, generatePanoTiles, panoEligible } from '../media/tiles.ts';
import { assertDiskReserve } from '../media/disk.ts';

export type JobContext = {
  db: DatabaseSync;
  config: AppConfig;
  job: Job;
  workerId: string;
  signal: AbortSignal;
  reportProgress: (progress: number) => void;
};

export type JobHandler = (context: JobContext) => Promise<void>;

function loadMediaForJob(context: JobContext): MediaRow | null {
  const { db, job } = context;
  if (!job.media_id) throw new PermanentJobError('Job is missing a media reference');
  const media = getRow<MediaRow>(db, 'SELECT * FROM media WHERE id = ?', job.media_id);
  if (!media) return null;
  if (job.source_version !== null && media.source_version !== job.source_version) return null;
  return media;
}

/**
 * A probe that can never succeed must not leave the item looking permanently
 * busy. The outcome is recorded so the API and viewer can explain it: a raw DJI
 * OSV is unsupported by design, while an unreadable file is a retryable failure.
 */
function recordProbeFailure(db: DatabaseSync, media: MediaRow, error: unknown): void {
  const rawOsv = media.extension.toLowerCase() === '.osv';
  const reason = rawOsv ? DJI_EXPORT_GUIDANCE : `Metadata could not be read: ${sanitizeError(error)}`;
  const now = nowIso();
  run(
    db,
    `INSERT INTO media_metadata (media_id, metadata_source, projection_source, direct_play, capture_date_certain,
                                 unsupported_reason, probed_at)
     VALUES (?, 'unavailable', 'unknown', 0, 0, ?, ?)
     ON CONFLICT(media_id) DO UPDATE SET unsupported_reason = excluded.unsupported_reason, probed_at = excluded.probed_at`,
    media.id,
    reason,
    now,
  );
  run(
    db,
    `UPDATE media SET processing_state = ?, updated_at = ? WHERE id = ?`,
    rawOsv ? 'unsupported' : 'failed',
    now,
    media.id,
  );
}

const handlers: Record<string, JobHandler> = {
  scan_root: async (context) => {
    const payload = JSON.parse(context.job.payload) as { rootId?: unknown };
    if (typeof payload.rootId !== 'string') throw new PermanentJobError('Scan job is missing its root id');
    context.reportProgress(0.05);
    await scanRoot(context.db, context.config, payload.rootId);
    context.reportProgress(1);
  },

  probe_media: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    context.reportProgress(0.2);

    const absolutePath = mediaFilePath(context.config.roots, media);
    let outcome;
    try {
      outcome = await probeMediaFile(
        context.config,
        media.media_type,
        absolutePath,
        media.extension,
        media.mtime_ms,
      );
    } catch (error) {
      recordProbeFailure(context.db, media, error);
      throw error;
    }
    context.reportProgress(0.7);

    transaction(context.db, () => {
      const now = nowIso();
      context.db
        .prepare(
          `INSERT INTO media_metadata (media_id, width, height, duration_ms, video_codec, audio_codec, bit_depth,
                                      frame_rate, color_space, color_transfer, color_primaries, rotation_degrees,
                                      metadata_source, projection_source, direct_play,
                                      gps_lat, gps_lon, capture_date_certain, unsupported_reason, probed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(media_id) DO UPDATE SET
             width = excluded.width, height = excluded.height, duration_ms = excluded.duration_ms,
             video_codec = excluded.video_codec, audio_codec = excluded.audio_codec, bit_depth = excluded.bit_depth,
             frame_rate = excluded.frame_rate, color_space = excluded.color_space,
             color_transfer = excluded.color_transfer, color_primaries = excluded.color_primaries,
             rotation_degrees = excluded.rotation_degrees,
             metadata_source = excluded.metadata_source, projection_source = excluded.projection_source,
             direct_play = excluded.direct_play, gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon,
             capture_date_certain = excluded.capture_date_certain,
             unsupported_reason = excluded.unsupported_reason, probed_at = excluded.probed_at`,
        )
        .run(
          media.id,
          outcome.width,
          outcome.height,
          outcome.durationMs,
          outcome.videoCodec,
          outcome.audioCodec,
          outcome.bitDepth,
          outcome.frameRate,
          outcome.colorSpace,
          outcome.colorTransfer,
          outcome.colorPrimaries,
          outcome.rotationDegrees,
          outcome.metadataSource,
          outcome.projectionSource,
          outcome.directPlay ? 1 : 0,
          outcome.gps?.lat ?? null,
          outcome.gps?.lon ?? null,
          outcome.captureDateCertain ? 1 : 0,
          outcome.unsupportedReason,
          now,
        );

      // A compatible original needs no rendition; an incompatible one is
      // queued for encoding rather than being declared unsupported.
      const unsupportedReason = outcome.unsupportedReason;
      const processingState = unsupportedReason ? 'unsupported' : 'processing';

      run(
        context.db,
        `UPDATE media SET projection = ?, capture_date = ?, processing_state = ?, updated_at = ? WHERE id = ?`,
        outcome.projection,
        outcome.captureDate,
        processingState,
        now,
        media.id,
      );
      if (unsupportedReason) {
        run(
          context.db,
          `UPDATE media_metadata SET unsupported_reason = ? WHERE media_id = ?`,
          unsupportedReason,
          media.id,
        );
      }
    });

    // Content hashing is independent of playback support: unsupported or
    // non-direct-play files can still be duplicates of another copy.
    enqueue(context.db, {
      kind: 'hash_media',
      dedupeKey: `hash:${media.id}:v${media.source_version}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      priority: 3,
    });

    // Pairing is attempted from either camera file, so scan order and late
    // arrivals converge on the same directional relationship.
    enqueue(context.db, {
      kind: 'pair_companion',
      dedupeKey: `pair:${media.id}:v${media.source_version}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      priority: 4,
    });

    if (outcome.unsupportedReason) return;

    if (media.media_type === 'video') {
      for (const profile of RENDITION_PROFILE_LIST) {
        // The standard profile is the playable fallback for sources the
        // browser cannot decode, so direct-play files skip it.
        if (profile.recipe === RENDITION_RECIPE && outcome.directPlay) continue;
        // A further profile is only worth encoding when it actually downscales.
        if (
          profile.recipe !== RENDITION_RECIPE &&
          !needsRendition(outcome.width ?? 0, outcome.height ?? 0, outcome.projection, profile)
        ) {
          continue;
        }
        enqueue(context.db, {
          kind: 'video_rendition',
          dedupeKey: `rendition:${media.id}:v${media.source_version}:${profile.recipe}`,
          mediaId: media.id,
          sourceVersion: media.source_version,
          profileVersion: profile.recipe,
          priority: 2,
        });
      }
    }

    enqueue(context.db, {
      kind: 'thumbnail',
      dedupeKey: `thumbnail:${media.id}:v${media.source_version}:${THUMBNAIL_RECIPE}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      profileVersion: THUMBNAIL_RECIPE,
      priority: 1,
    });

    // Only large equirectangular photos are worth a cube pyramid; smaller ones
    // stay on the flat preview. Tiling runs at the lowest priority so gallery
    // thumbnails and playback readiness are never delayed by it.
    if (panoEligible(media.media_type, outcome.projection, outcome.width)) {
      enqueue(context.db, {
        kind: 'pano_tiles',
        dedupeKey: `tiles:${media.id}:v${media.source_version}:${PANO_TILE_RECIPE}`,
        mediaId: media.id,
        sourceVersion: media.source_version,
        profileVersion: PANO_TILE_RECIPE,
        priority: 0,
      });
    }
    context.reportProgress(1);
  },

  thumbnail: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    assertDiskReserve(context.config);
    context.reportProgress(0.2);
    try {
      await generateDerivatives(context.db, context.config, context.job.id, media);
    } catch (error) {
      if (media.media_type === 'photo') {
        // For a photo the preview *is* the usable representation.
        run(
          context.db,
          `UPDATE media SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
          nowIso(),
          media.id,
        );
      } else {
        // A missing poster must not hide a playable original.
        const metadata = getRow<{ direct_play: number }>(
          context.db,
          'SELECT direct_play FROM media_metadata WHERE media_id = ?',
          media.id,
        );
        if (metadata?.direct_play === 1) {
          run(
            context.db,
            `UPDATE media SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
            nowIso(),
            media.id,
          );
        }
      }
      throw error instanceof Error && /decode|unsupported/i.test(error.message)
        ? new PermanentJobError(sanitizeError(error))
        : error;
    }
    context.reportProgress(1);
  },

  video_rendition: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    const profile = renditionProfile(context.job.profile_version ?? RENDITION_RECIPE);
    if (!profile) {
      throw new PermanentJobError(`Unknown rendition profile: ${context.job.profile_version}`);
    }
    assertDiskReserve(context.config);
    try {
      await generateRendition(
        context.db,
        context.config,
        context.job.id,
        media,
        profile,
        context.reportProgress,
        context.signal,
      );
    } catch (error) {
      if (error instanceof PermanentJobError) {
        run(
          context.db,
          `UPDATE media SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
          nowIso(),
          media.id,
        );
      }
      throw error;
    }
  },

  hash_media: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    context.reportProgress(0.1);
    const contentHash = await hashMediaFile(context.config, media, context.signal);
    context.reportProgress(0.9);
    recordContentHash(context.db, media.id, contentHash);
    context.reportProgress(1);
  },

  pano_tiles: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    assertDiskReserve(context.config);
    // Tiles are an enhancement: a failure leaves the flat preview usable and
    // must not mark the photo itself as failed or unsupported.
    await generatePanoTiles(
      context.db,
      context.config,
      context.job.id,
      media,
      context.reportProgress,
      context.signal,
    );
  },

  pair_companion: async (context) => {
    const media = loadMediaForJob(context);
    if (!media) return;
    const outcome = evaluateCompanionPair(context.db, media.id);
    // A new or changed companion can supply a better poster frame; regenerate
    // the canonical item's preview assets through the normal durable job.
    if (outcome.status === 'paired' && outcome.canonicalId) {
      const canonical = getRow<MediaRow>(context.db, 'SELECT * FROM media WHERE id = ?', outcome.canonicalId);
      if (canonical) {
        enqueue(context.db, {
          kind: 'thumbnail',
          dedupeKey: `thumbnail:${canonical.id}:v${canonical.source_version}:${THUMBNAIL_RECIPE}`,
          mediaId: canonical.id,
          sourceVersion: canonical.source_version,
          profileVersion: THUMBNAIL_RECIPE,
          priority: 1,
        });
      }
    }
    context.reportProgress(1);
  },
};

export function handlerFor(kind: string): JobHandler | undefined {
  return handlers[kind];
}

/**
 * Re-queues catalog rows that were left pending by a crash or an early scan.
 * Bounded so a huge backlog cannot delay real work indefinitely.
 */
export function enqueueMissingDerivatives(db: DatabaseSync, limit = 200): number {
  const missing = getRows<{ id: string; source_version: number }>(
    db,
    `SELECT m.id, m.source_version FROM media m
      WHERE m.availability = 'present' AND m.processing_state = 'ready'
        AND EXISTS (
          SELECT 1 FROM derivatives failed
           WHERE failed.media_id = m.id AND failed.source_version = m.source_version
             AND failed.state = 'failed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM derivatives ready
           WHERE ready.media_id = m.id AND ready.source_version = m.source_version
             AND ready.recipe_version = ? AND ready.kind = 'thumbnail' AND ready.state = 'ready'
        )
      ORDER BY m.updated_at DESC LIMIT ?`,
    THUMBNAIL_RECIPE,
    limit,
  );
  let enqueued = 0;
  for (const media of missing) {
    const created = enqueue(db, {
      kind: 'thumbnail',
      dedupeKey: `thumbnail:${media.id}:v${media.source_version}:${THUMBNAIL_RECIPE}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      profileVersion: THUMBNAIL_RECIPE,
      priority: 3,
    });
    if (created) enqueued += 1;
  }
  return enqueued;
}

export function enqueueBacklog(db: DatabaseSync, limit = 200): number {
  const pending = getRows<{ id: string; source_version: number; mtime_ms: number; availability: string }>(
    db,
    `SELECT id, source_version, mtime_ms, availability FROM media
      WHERE processing_state = 'pending' AND availability = 'present' LIMIT ?`,
    limit,
  );
  let enqueued = 0;
  for (const media of pending) {
    const created = enqueue(db, {
      kind: 'probe_media',
      dedupeKey: `probe:${media.id}:v${media.source_version}`,
      mediaId: media.id,
      sourceVersion: media.source_version,
      priority: 2,
    });
    if (created) enqueued += 1;
  }
  return enqueued;
}
