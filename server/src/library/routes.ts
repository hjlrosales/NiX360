import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import { nowIso } from '../config.ts';
import { getRow, getRows, run } from '../db/sqlite.ts';
import { audit, requireAdmin, requireUser } from '../auth/routes.ts';
import { duplicateGroupSize } from '../media/hash.ts';
import { EXCLUDE_CONFIRMED_COMPANION, canonicalMediaId, companionPreview } from '../media/companions.ts';
import { linkedExport } from '../media/exports.ts';
import { PANO_MIN_SOURCE_WIDTH, PANO_TILE_RECIPE, panoramaStatus } from '../media/tiles.ts';
import { EFFECTIVE_PROJECTION_SQL, effectiveProjection, isProjectionValue } from '../media/projection.ts';
import { RENDITION_PROFILE_LIST, renditionProfile } from '../media/rendition.ts';
import { hdrKind } from '../media/probe.ts';
import { describeExperience } from '../media/experience.ts';
import { enqueue } from '../jobs/queue.ts';

export type LibraryDeps = { db: DatabaseSync; config: AppConfig };

/** A playable representation the client may choose without re-encoding anything. */
type PlaybackOption = {
  kind: 'preview' | 'rendition' | 'original' | 'export';
  profile: string | null;
  url: string;
  label: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  directPlay: boolean;
  /** Effective projection of the file this option actually serves. */
  projection: string;
  /** True for an equirectangular representation; the viewer labels it explicitly. */
  spherical: boolean;
  /** True when an HDR/wide-gamut source was converted to SDR for this option. */
  toneMapped: boolean;
};

type MediaListRow = {
  id: string;
  media_type: 'photo' | 'video';
  projection: string;
  processing_state: string;
  availability: string;
  capture_date: string | null;
  rel_path: string;
  size_bytes: number;
  source_version: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  direct_play: number | null;
  unsupported_reason: string | null;
  capture_date_certain: number | null;
  sort_key: string;  favorite_created_at: string | null;
  viewed_at: string | null;
};

const PROJECTIONS = new Set(['flat', 'equirectangular', 'dual_fisheye', 'unknown']);
const MAX_LIMIT = 100;

export function serializeMedia(row: MediaListRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.media_type,
    projection: row.projection,
    processingState: row.processing_state,
    availability: row.availability,
    captureDate: row.capture_date,
    captureDateCertain: row.capture_date_certain === 1,
    fileName: row.rel_path.split('/').pop() ?? row.rel_path,
    relativePath: row.rel_path,
    folder: row.rel_path.includes('/') ? row.rel_path.slice(0, row.rel_path.lastIndexOf('/')) : '',
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    directPlay: row.direct_play === 1,
    unsupportedReason: row.unsupported_reason,
    favorite: row.favorite_created_at !== null,
    lastViewedAt: row.viewed_at,
    sourceVersion: row.source_version,
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    posterUrl: row.media_type === 'video' ? `/api/media/${row.id}/poster` : null,
    previewUrl: row.media_type === 'photo' ? `/api/media/${row.id}/preview` : null,
    originalUrl: `/api/media/${row.id}/original`,
  };
}

type Cursor = { k: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.k !== 'string' || typeof parsed.id !== 'string') throw new Error('bad cursor');
    return parsed;
  } catch {
    throw new Error('invalid_cursor');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type GpsRange = { latMin: number; latMax: number; lonMin: number; lonMax: number };

/** Accepts either no coordinate filter or a complete, sane bounding box. */
function parseGpsRange(query: Record<string, string | undefined>): GpsRange | null | 'invalid' {
  const keys = ['latMin', 'latMax', 'lonMin', 'lonMax'] as const;
  const provided = keys.filter((key) => query[key] !== undefined && query[key] !== '');
  if (provided.length === 0) return null;
  if (provided.length !== keys.length) return 'invalid';
  const values = keys.map((key) => Number(query[key]));
  if (values.some((value) => !Number.isFinite(value))) return 'invalid';
  const [latMin, latMax, lonMin, lonMax] = values as [number, number, number, number];
  if (latMin < -90 || latMax > 90 || lonMin < -180 || lonMax > 180) return 'invalid';
  if (latMin > latMax || lonMin > lonMax) return 'invalid';
  return { latMin, latMax, lonMin, lonMax };
}

/**
 * Normalizes a client-supplied folder path. Empty means the library root; any
 * traversal, absolute path or over-long value is rejected rather than repaired.
 */
function normalizeFolderPath(raw: string): string | null {
  const value = raw.trim().replace(/\\/g, '/');
  if (value === '') return '';
  if (value.length > 1024) return null;
  const segments = value.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return '';
  if (segments.length > 32) return null;
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\u0000'))) return null;
  return segments.join('/');
}

export function registerLibraryRoutes(app: FastifyInstance, { db }: LibraryDeps): void {
  app.get('/api/library', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    const query = request.query as Record<string, string | undefined>;
    const limitRaw = Number(query.limit ?? 60);
    const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitRaw))) : 60;
    const mediaType = query.type ?? '';
    if (mediaType !== '' && mediaType !== 'photo' && mediaType !== 'video') {
      return reply.code(400).send({ error: 'invalid_type' });
    }
    const projection = query.projection ?? '';
    if (projection !== '' && !PROJECTIONS.has(projection)) {
      return reply.code(400).send({ error: 'invalid_projection' });
    }
    const search = (query.q ?? '').trim().slice(0, 200);
    const favoritedOnly = query.favorite === '1';
    const historyOnly = query.history === '1';
    const folderPath = normalizeFolderPath(query.folder ?? '');
    if (folderPath === null) return reply.code(400).send({ error: 'invalid_folder' });
    const gpsRange = parseGpsRange(query);
    if (gpsRange === 'invalid') return reply.code(400).send({ error: 'invalid_gps_range' });
    const from = (query.from ?? '').trim();
    const to = (query.to ?? '').trim();
    if ((from !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      return reply.code(400).send({ error: 'invalid_date' });
    }
    if (from !== '' && to !== '' && from > to) return reply.code(400).send({ error: 'invalid_date_range' });

    const sortExpression = historyOnly
      ? 'COALESCE(h.last_viewed_at, m.created_at)'
      : favoritedOnly
        ? 'COALESCE(f.created_at, m.created_at)'
        : 'COALESCE(m.capture_date, m.created_at)';

    const conditions: string[] = ["m.availability = 'present'", EXCLUDE_CONFIRMED_COMPANION];
    const params: (string | number | null)[] = [user.id, user.id];

    if (mediaType !== '') {
      conditions.push('m.media_type = ?');
      params.push(mediaType);
    }
    if (projection !== '') {
      conditions.push(`${EFFECTIVE_PROJECTION_SQL} = ?`);
      params.push(projection);
    }
    if (search !== '') {
      conditions.push("m.rel_path LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(search)}%`);
    }
    if (favoritedOnly) conditions.push('f.user_id IS NOT NULL');
    if (historyOnly) conditions.push('h.user_id IS NOT NULL');
    if (folderPath !== '') {
      conditions.push("m.rel_path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(folderPath)}/%`);
    }
    if (gpsRange !== null) {
      conditions.push('md.gps_lat BETWEEN ? AND ? AND md.gps_lon BETWEEN ? AND ?');
      params.push(gpsRange.latMin, gpsRange.latMax, gpsRange.lonMin, gpsRange.lonMax);
    }
    // Dates fall back to the catalog insertion time when capture metadata is
    // absent, matching the ordering used by the gallery.
    if (from !== '') {
      conditions.push('COALESCE(m.capture_date, m.created_at) >= ?');
      params.push(from);
    }
    if (to !== '') {
      conditions.push('COALESCE(m.capture_date, m.created_at) <= ?');
      params.push(`${to}T23:59:59.999Z`);
    }

    if (typeof query.cursor === 'string' && query.cursor !== '') {
      let cursor: Cursor;
      try {
        cursor = decodeCursor(query.cursor);
      } catch {
        return reply.code(400).send({ error: 'invalid_cursor' });
      }
      conditions.push(`(${sortExpression} < ? OR (${sortExpression} = ? AND m.id < ?))`);
      params.push(cursor.k, cursor.k, cursor.id);
    }

    const sql = `
      SELECT m.id, m.media_type, ${EFFECTIVE_PROJECTION_SQL} AS projection, m.processing_state, m.availability,
             m.capture_date, m.rel_path, m.size_bytes, m.source_version,
             md.width, md.height, md.duration_ms, md.direct_play, md.unsupported_reason, md.capture_date_certain,
             ${sortExpression} AS sort_key,
             f.created_at AS favorite_created_at,
             h.last_viewed_at AS viewed_at
        FROM media m
        LEFT JOIN media_metadata md ON md.media_id = m.id
        LEFT JOIN favorites f ON f.media_id = m.id AND f.user_id = ?
        LEFT JOIN viewing_history h ON h.media_id = m.id AND h.user_id = ?
       WHERE ${conditions.join(' AND ')}
       ORDER BY sort_key DESC, m.id DESC
       LIMIT ?`;
    params.push(limit + 1);

    const rows = getRows<MediaListRow>(db, sql, ...params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ k: last.sort_key, id: last.id }) : null;

    return reply.send({ items: page.map(serializeMedia), nextCursor });
  });

  /**
   * Immediate child folders of a root-relative path, with counts. Paths are
   * derived from catalog data only, so a client cannot request a host path.
   */
  app.get('/api/folders', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    const query = request.query as { path?: string };
    const folderPath = normalizeFolderPath(query.path ?? '');
    if (folderPath === null) return reply.code(400).send({ error: 'invalid_folder' });

    const prefix = folderPath === '' ? '' : `${folderPath}/`;
    const rows = getRows<{ id: string; rel_path: string }>(
      db,
      `SELECT id, rel_path FROM media
        WHERE availability = 'present' AND (? = '' OR rel_path LIKE ? ESCAPE '\\')
        ORDER BY rel_path
        LIMIT 50001`,
      prefix,
      prefix === '' ? '' : `${escapeLike(prefix)}%`,
    );
    const truncated = rows.length > 50000;
    const counts = new Map<string, number>();
    let mediaCount = 0;

    // Confirmed companions are the same recording as their OSV, so they never
    // add to folder counts.
    const companionIds = new Set(
      getRows<{ media_id: string }>(
        db,
        `SELECT related_media_id AS media_id FROM media_relations
          WHERE relation_type = 'preview_companion' AND status = 'confirmed'`,
      ).map((row) => row.media_id),
    );

    for (const row of rows.slice(0, 50000)) {
      if (companionIds.has(row.id)) continue;
      const rest = prefix === '' ? row.rel_path : row.rel_path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        mediaCount += 1;
        continue;
      }
      const name = rest.slice(0, slash);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    return reply.send({
      path: folderPath,
      mediaCount,
      truncated,
      folders: [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => ({ name, path: folderPath === '' ? name : `${folderPath}/${name}`, count })),
    });
  });

  app.get('/api/media/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id: requestedId } = request.params as { id: string };
    // Existing companion deep links resolve to the canonical recording.
    const id = canonicalMediaId(db, requestedId);

    const row = getRow<
      MediaListRow & {
        missing_since: string | null;
        mtime_ms: number;
        content_hash: string | null;
        resume_position: number | null;
      }
    >(
      db,
      `SELECT m.*, md.width, md.height, md.duration_ms, md.direct_play, md.unsupported_reason,
              md.capture_date_certain, COALESCE(m.capture_date, m.created_at) AS sort_key,
              f.created_at AS favorite_created_at, h.last_viewed_at AS viewed_at,
              h.position_seconds AS resume_position
         FROM media m
         LEFT JOIN media_metadata md ON md.media_id = m.id
         LEFT JOIN favorites f ON f.media_id = m.id AND f.user_id = ?
         LEFT JOIN viewing_history h ON h.media_id = m.id AND h.user_id = ?
        WHERE m.id = ?`,
      user.id,
      user.id,
      id,
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const metadata = getRow<Record<string, unknown>>(db, 'SELECT * FROM media_metadata WHERE media_id = ?', id);
    const hdr = metadata
      ? hdrKind(
          (metadata.color_transfer as string | null) ?? null,
          (metadata.color_primaries as string | null) ?? null,
        )
      : null;
    const derivatives = getRows<Record<string, unknown>>(
      db,
      'SELECT kind, storage_key, bytes, width, height, state, recipe_version FROM derivatives WHERE media_id = ? AND source_version = ?',
      id,
      row.source_version,
    );
    const overrides = getRow<Record<string, unknown>>(db, 'SELECT * FROM media_overrides WHERE media_id = ?', id);
    // Probe evidence is the fallback classification; an override replaces it.
    const effective = { ...row, projection: effectiveProjection(db, id, row.projection) };
    const contentHash = row.content_hash ?? null;
    const preview = companionPreview(db, id);
    // A confirmed full-sphere export supplies playback for a raw original. The
    // original keeps its own conversion-required state; the export carries its
    // own versions, projection and provenance.
    const exportLink = row.media_type === 'video' ? linkedExport(db, id) : null;
    const exportRenditions = exportLink
      ? getRows<{ recipe_version: string; bytes: number | null; width: number | null; height: number | null }>(
          db,
          `SELECT recipe_version, bytes, width, height FROM derivatives
            WHERE media_id = ? AND source_version = ? AND kind = 'video' AND state = 'ready'`,
          exportLink.mediaId,
          exportLink.sourceVersion,
        ).sort(
          (left, right) =>
            profileOrder.indexOf(left.recipe_version) - profileOrder.indexOf(right.recipe_version),
        )
      : [];
    const exportPlayable =
      exportLink !== null &&
      exportLink.availability === 'present' &&
      (exportLink.directPlay || exportRenditions.length > 0);
    const profileOrder = RENDITION_PROFILE_LIST.map((profile) => profile.recipe);
    const readyRenditions = derivatives
      .filter((derivative) => derivative.kind === 'video' && derivative.state === 'ready')
      .map((derivative) => {
        const recipe = String(derivative.recipe_version ?? '');
        return {
          recipe,
          label: renditionProfile(recipe)?.label ?? recipe,
          bytes: (derivative.bytes as number | null) ?? null,
          width: (derivative.width as number | null) ?? null,
          height: (derivative.height as number | null) ?? null,
        };
      })
      .sort((left, right) => {
        const leftRank = profileOrder.indexOf(left.recipe);
        const rightRank = profileOrder.indexOf(right.recipe);
        return (
          (leftRank === -1 ? profileOrder.length : leftRank) -
          (rightRank === -1 ? profileOrder.length : rightRank)
        );
      });
    // Every playable representation is offered, best first. A confirmed
    // compatible LRF plays without encoding; a verified direct-play original
    // beats re-encoded output; precomputed renditions cover the rest. A raw
    // original is never offered unless probing verified direct playback.
    const playbackOptions: PlaybackOption[] = [];
    if (row.media_type === 'video') {
      if (preview && preview.availability === 'present' && preview.direct_play === 1) {
        playbackOptions.push({
          kind: 'preview',
          profile: null,
          url: `/api/media/${preview.id}/original`,
          label: 'Preview (LRF)',
          width: preview.width,
          height: preview.height,
          bytes: null,
          directPlay: true,
          // The companion's own classification, never the recording's.
          projection: preview.projection,
          spherical: preview.projection === 'equirectangular',
          toneMapped: false,
        });
      }
      // A linked export is the next-best evidence after a confirmed LRF
      // preview: it is a stitched sphere rather than the raw camera file.
      if (exportLink && exportPlayable) {
        if (exportLink.directPlay) {
          playbackOptions.push({
            kind: 'export',
            profile: null,
            url: `/api/media/${exportLink.mediaId}/original`,
            label: 'Spherical export',
            width: exportLink.width,
            height: exportLink.height,
            bytes: null,
            directPlay: true,
            projection: 'equirectangular',
            spherical: true,
            toneMapped: false,
          });
        }
        for (const rendition of exportRenditions) {
          playbackOptions.push({
            kind: 'export',
            profile: rendition.recipe_version,
            url: `/api/media/${exportLink.mediaId}/rendition?profile=${encodeURIComponent(rendition.recipe_version)}`,
            label: `Spherical export · ${renditionProfile(rendition.recipe_version)?.label ?? rendition.recipe_version}`,
            width: rendition.width,
            height: rendition.height,
            bytes: rendition.bytes,
            directPlay: true,
            projection: 'equirectangular',
            spherical: true,
            toneMapped: false,
          });
        }
      }
      if (row.direct_play === 1) {
        playbackOptions.push({
          kind: 'original',
          profile: null,
          url: `/api/media/${id}/original`,
          label: 'Original',
          width: (row.width as number | null) ?? null,
          height: (row.height as number | null) ?? null,
          bytes: (row.size_bytes as number | null) ?? null,
          directPlay: true,
          projection: effective.projection,
          spherical: effective.projection === 'equirectangular',
          toneMapped: false,
        });
      }
      for (const rendition of readyRenditions) {
        // The pipeline always publishes SDR BT.709, so an HDR source's
        // rendition is labeled as converted rather than presented as the file.
        playbackOptions.push({
          kind: 'rendition',
          profile: rendition.recipe,
          url: `/api/media/${id}/rendition?profile=${encodeURIComponent(rendition.recipe)}`,
          label: hdr ? `${rendition.label} (HDR → SDR)` : rendition.label,
          width: rendition.width,
          height: rendition.height,
          bytes: rendition.bytes,
          directPlay: true,
          projection: effective.projection,
          spherical: effective.projection === 'equirectangular',
          toneMapped: hdr !== null,
        });
      }
    }
    const playback = playbackOptions[0] ?? null;
    // One explicit answer for the client instead of four columns to interpret.
    const unsupportedReason = (metadata?.unsupported_reason as string | null) ?? null;
    const experience = describeExperience({
      mediaType: row.media_type,
      processingState: row.processing_state,
      hasPlayback: playback !== null,
      hasExportPlayback: exportPlayable,
      unsupportedReason,
    });

    return reply.send({
      ...serializeMedia(effective),
      canonicalId: id,
      requestedId,
      // A linked export makes the recording playable but does not convert the
      // raw original, so that state is reported separately.
      originalConversionRequired:
        row.media_type === 'video' &&
        (experience.state === 'conversion_required' || row.processing_state === 'unsupported'),
      experience,
      export: exportLink
        ? {
            ...exportLink,
            playable: exportPlayable,
          }
        : null,
      companion: preview
        ? {
            mediaId: preview.id,
            fileName: preview.rel_path.split('/').pop() ?? preview.rel_path,
            relativePath: preview.rel_path,
            availability: preview.availability,
            sourceVersion: preview.source_version,
            width: preview.width,
            height: preview.height,
            durationMs: preview.duration_ms,
            videoCodec: preview.video_codec,
            projection: preview.projection,
            directPlay: preview.direct_play === 1,
            url: `/api/media/${preview.id}/original`,
          }
        : null,
      playback,
      playbackOptions,
      // Why the interactive viewer is (or is not) available for this photo.
      tiles: row.media_type === 'photo' ? panoramaStatus(db, effective, row.width) : null,
      // Resume is per user; a missing row means start from the beginning. The
      // client also ignores positions too close to the end.
      playbackPositionSeconds: row.resume_position ?? null,
      missingSince: row.missing_since,
      contentHash,
      duplicateCount: duplicateGroupSize(db, contentHash, row.id),
      metadata: metadata
        ? {
            width: metadata.width,
            height: metadata.height,
            durationMs: metadata.duration_ms,
            videoCodec: metadata.video_codec,
            audioCodec: metadata.audio_codec,
            bitDepth: metadata.bit_depth,
            frameRate: metadata.frame_rate,
            colorSpace: metadata.color_space,
            colorTransfer: metadata.color_transfer,
            colorPrimaries: metadata.color_primaries,
            hdr,
            rotationDegrees: (metadata.rotation_degrees as number | null) ?? 0,
            metadataSource: metadata.metadata_source,
            // An override is a recorded classification decision, not extracted metadata.
            projectionSource: overrides?.projection ? 'override' : metadata.projection_source,
            directPlay: metadata.direct_play === 1,
            gps: metadata.gps_lat !== null && metadata.gps_lon !== null ? { lat: metadata.gps_lat, lon: metadata.gps_lon } : null,
            unsupportedReason: metadata.unsupported_reason,
            probedAt: metadata.probed_at,
          }
        : null,
      overrides: overrides ?? null,
      renditionUrl: readyRenditions[0]
        ? `/api/media/${id}/rendition?profile=${encodeURIComponent(readyRenditions[0].recipe)}`
        : null,
      derivatives: derivatives.map((derivative) => ({
        kind: derivative.kind,
        bytes: derivative.bytes,
        width: derivative.width,
        height: derivative.height,
        state: derivative.state,
        recipeVersion: derivative.recipe_version,
      })),
    });
  });

  type OrientationFieldKey = 'yawDegrees' | 'pitchDegrees' | 'rollDegrees';
  type OverrideFieldKey = OrientationFieldKey | 'projection';
  const ORIENTATION_LIMITS: Record<OrientationFieldKey, number> = {
    yawDegrees: 180,
    pitchDegrees: 90,
    rollDegrees: 180,
  };

  /**
   * Catalog overrides: the 360° starting direction and an explicit projection.
   * Both are administrative metadata for the shared household library; no source
   * file is ever touched, and a projection override drives tile eligibility.
   */
  app.patch('/api/media/:id/overrides', async (request, reply) => {
    const user = requireAdmin(request, reply);
    if (!user) return reply;
    const { id: requestedId } = request.params as { id: string };
    const id = canonicalMediaId(db, requestedId);

    const body = (request.body ?? {}) as Partial<Record<OverrideFieldKey, unknown>>;
    const provided = (['yawDegrees', 'pitchDegrees', 'rollDegrees', 'projection'] as const).filter(
      (key) => body[key] !== undefined,
    );
    if (provided.length === 0) return reply.code(400).send({ error: 'invalid_request' });

    const orientationChanges: Partial<Record<OrientationFieldKey, number | null>> = {};
    let projectionChange: string | null | undefined;
    for (const key of provided) {
      const value = body[key];
      if (key === 'projection') {
        if (value !== null && !isProjectionValue(value)) {
          return reply.code(400).send({ error: 'invalid_projection' });
        }
        projectionChange = value;
        continue;
      }
      if (value !== null) {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > ORIENTATION_LIMITS[key]) {
          return reply.code(400).send({ error: 'invalid_orientation' });
        }
        orientationChanges[key] = value;
      } else {
        orientationChanges[key] = null;
      }
    }

    const media = getRow<{ id: string; media_type: string; source_version: number }>(
      db,
      'SELECT id, media_type, source_version FROM media WHERE id = ?',
      id,
    );
    if (!media) return reply.code(404).send({ error: 'not_found' });
    if (media.media_type !== 'photo') return reply.code(400).send({ error: 'not_a_photo' });

    const existing = getRow<{
      title: string | null;
      display_date: string | null;
      projection: string | null;
      yaw_degrees: number | null;
      pitch_degrees: number | null;
      roll_degrees: number | null;
    }>(db, 'SELECT title, display_date, projection, yaw_degrees, pitch_degrees, roll_degrees FROM media_overrides WHERE media_id = ?', id);

    const projection = projectionChange !== undefined ? projectionChange : existing?.projection ?? null;
    const orientation = {
      yaw: orientationChanges.yawDegrees !== undefined ? orientationChanges.yawDegrees : existing?.yaw_degrees ?? null,
      pitch: orientationChanges.pitchDegrees !== undefined ? orientationChanges.pitchDegrees : existing?.pitch_degrees ?? null,
      roll: orientationChanges.rollDegrees !== undefined ? orientationChanges.rollDegrees : existing?.roll_degrees ?? null,
    };
    const now = nowIso();
    run(
      db,
      `INSERT INTO media_overrides (media_id, title, display_date, projection, yaw_degrees, pitch_degrees, roll_degrees, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET projection = excluded.projection, yaw_degrees = excluded.yaw_degrees,
             pitch_degrees = excluded.pitch_degrees, roll_degrees = excluded.roll_degrees, updated_at = excluded.updated_at`,
      id,
      existing?.title ?? null,
      existing?.display_date ?? null,
      projection,
      orientation.yaw,
      orientation.pitch,
      orientation.roll,
      now,
    );

    // Tiles follow the effective classification: a confirmed sphere is tiled
    // now, and work queued for a photo that no longer tiles is dropped.
    if (projection === 'equirectangular') {
      const width = getRow<{ width: number | null }>(
        db,
        'SELECT width FROM media_metadata WHERE media_id = ?',
        id,
      )?.width ?? null;
      if ((width ?? 0) >= PANO_MIN_SOURCE_WIDTH) {
        enqueue(db, {
          kind: 'pano_tiles',
          dedupeKey: `tiles:${id}:v${media.source_version}:${PANO_TILE_RECIPE}`,
          mediaId: id,
          sourceVersion: media.source_version,
          profileVersion: PANO_TILE_RECIPE,
          priority: 0,
        });
      }
    } else {
      run(
        db,
        `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, updated_at = ?
          WHERE kind = 'pano_tiles' AND media_id = ? AND status IN ('queued', 'retry_wait', 'paused')`,
        now,
        now,
        id,
      );
    }

    audit(db, user.id, 'media.overrides_changed', id);
    const updated = getRow<{
      id: string;
      media_type: string;
      projection: string;
      availability: string;
      source_version: number;
      width: number | null;
    }>(
      db,
      `SELECT m.id, m.media_type, ${EFFECTIVE_PROJECTION_SQL} AS projection, m.availability, m.source_version, md.width
         FROM media m LEFT JOIN media_metadata md ON md.media_id = m.id
        WHERE m.id = ?`,
      id,
    );
    return reply.send({
      orientation: { yaw: orientation.yaw ?? 0, pitch: orientation.pitch ?? 0, roll: orientation.roll ?? 0 },
      projection,
      tiles: updated ? panoramaStatus(db, updated, updated.width) : null,
    });
  });

  app.put('/api/media/:id/favorite', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { favorite?: unknown };
    if (typeof body.favorite !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });

    const media = getRow<{ id: string }>(db, 'SELECT id FROM media WHERE id = ?', id);
    if (!media) return reply.code(404).send({ error: 'not_found' });

    if (body.favorite) {
      run(
        db,
        'INSERT INTO favorites (user_id, media_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, media_id) DO NOTHING',
        user.id,
        id,
        nowIso(),
      );
    } else {
      run(db, 'DELETE FROM favorites WHERE user_id = ? AND media_id = ?', user.id, id);
    }
    return reply.send({ favorite: body.favorite });
  });

  app.post('/api/history', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = (request.body ?? {}) as { mediaId?: unknown; positionSeconds?: unknown };
    if (typeof body.mediaId !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    const position =
      typeof body.positionSeconds === 'number' && Number.isFinite(body.positionSeconds) && body.positionSeconds >= 0
        ? Math.floor(body.positionSeconds)
        : null;

    const media = getRow<{ id: string }>(db, 'SELECT id FROM media WHERE id = ?', body.mediaId);
    if (!media) return reply.code(404).send({ error: 'not_found' });

    run(
      db,
      `INSERT INTO viewing_history (user_id, media_id, last_viewed_at, position_seconds)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, media_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at,
             position_seconds = COALESCE(excluded.position_seconds, viewing_history.position_seconds)`,
      user.id,
      body.mediaId,
      nowIso(),
      position,
    );
    return reply.send({ ok: true });
  });

  app.get('/api/albums', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const albums = getRows<Record<string, unknown>>(
      db,
      `SELECT a.id, a.title, a.created_at, a.updated_at,
              (SELECT COUNT(*) FROM album_items ai WHERE ai.album_id = a.id) AS item_count
         FROM albums a WHERE a.owner_id = ? ORDER BY a.updated_at DESC`,
      user.id,
    );
    return reply.send({
      albums: albums.map((album) => ({
        id: album.id,
        title: album.title,
        itemCount: Number(album.item_count),
        createdAt: album.created_at,
        updatedAt: album.updated_at,
      })),
    });
  });

  app.post('/api/albums', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const body = (request.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    if (title === '') return reply.code(400).send({ error: 'invalid_title' });
    const id = randomUUID();
    const now = nowIso();
    run(db, 'INSERT INTO albums (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, user.id, title, now, now);
    return reply.code(201).send({ id, title, itemCount: 0, createdAt: now, updatedAt: now });
  });

  app.get('/api/albums/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = request.params as { id: string };
    const album = getRow<{ id: string; title: string; owner_id: string }>(db, 'SELECT * FROM albums WHERE id = ?', id);
    if (!album || album.owner_id !== user.id) return reply.code(404).send({ error: 'not_found' });

    const items = getRows<MediaListRow>(
      db,
      `SELECT m.id, m.media_type, ${EFFECTIVE_PROJECTION_SQL} AS projection, m.processing_state, m.availability,
              m.capture_date, m.rel_path, m.size_bytes, m.source_version, md.width, md.height, md.duration_ms, md.direct_play,
              md.unsupported_reason, md.capture_date_certain,
              COALESCE(m.capture_date, m.created_at) AS sort_key,
              f.created_at AS favorite_created_at, h.last_viewed_at AS viewed_at
         FROM album_items ai
         JOIN media m ON m.id = ai.media_id
         LEFT JOIN media_metadata md ON md.media_id = m.id
         LEFT JOIN favorites f ON f.media_id = m.id AND f.user_id = ?
         LEFT JOIN viewing_history h ON h.media_id = m.id AND h.user_id = ?
        WHERE ai.album_id = ?
          AND ${EXCLUDE_CONFIRMED_COMPANION}
        ORDER BY ai.position ASC, ai.added_at ASC`,
      user.id,
      user.id,
      id,
    );
    return reply.send({ id: album.id, title: album.title, items: items.map(serializeMedia) });
  });

  app.post('/api/albums/:id/items', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { mediaId?: unknown };
    if (typeof body.mediaId !== 'string') return reply.code(400).send({ error: 'invalid_request' });

    const album = getRow<{ id: string; owner_id: string }>(db, 'SELECT id, owner_id FROM albums WHERE id = ?', id);
    if (!album || album.owner_id !== user.id) return reply.code(404).send({ error: 'not_found' });
    const media = getRow<{ id: string }>(db, 'SELECT id FROM media WHERE id = ?', body.mediaId);
    if (!media) return reply.code(404).send({ error: 'not_found' });

    const max = getRow<{ position: number | null }>(db, 'SELECT MAX(position) AS position FROM album_items WHERE album_id = ?', id);
    run(
      db,
      `INSERT INTO album_items (album_id, media_id, position, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(album_id, media_id) DO NOTHING`,
      id,
      body.mediaId,
      (max?.position ?? 0) + 1,
      nowIso(),
    );
    run(db, 'UPDATE albums SET updated_at = ? WHERE id = ?', nowIso(), id);
    audit(db, user.id, 'album.item_added', id);
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/albums/:id/items/:mediaId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, mediaId } = request.params as { id: string; mediaId: string };
    const album = getRow<{ id: string; owner_id: string }>(db, 'SELECT id, owner_id FROM albums WHERE id = ?', id);
    if (!album || album.owner_id !== user.id) return reply.code(404).send({ error: 'not_found' });
    run(db, 'DELETE FROM album_items WHERE album_id = ? AND media_id = ?', id, mediaId);
    run(db, 'UPDATE albums SET updated_at = ? WHERE id = ?', nowIso(), id);
    return reply.send({ ok: true });
  });
}
