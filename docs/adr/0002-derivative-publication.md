# ADR 0002 — Versioned, atomically published derivatives

Date: 2026-11-05
Status: Accepted

## Context

Derivatives must survive crashes, source changes and recipe changes, and must never be served half-written or stale. Original files are read-only.

## Decision

- Storage key: `<media-id>/v<source-version>/<recipe-version>/<file>` under a dedicated derivatives directory, outside all media roots.
- A job writes into a per-job temp directory, then renames completed files into the final directory before committing derivative rows.
- Derivative rows are unique on `(media_id, source_version, recipe_version, kind)`; handlers return early when a ready row and its file already exist, so re-execution is idempotent.
- When a source changes, the scan bumps `source_version`, drops stale metadata and enqueues probe work. Publication deletes derivative rows and directories for superseded versions only.
- Worker startup reconciles ready rows whose files are missing by marking them failed so they can be regenerated.

## Consequences

- Recipe changes are isolated: a new `recipe_version` regenerates only that recipe.
- An interrupted encode restarts the rendition; frame-level resume is not claimed.
- Orphan files from a crash before the DB commit can exist until cleanup; the grace-period cleanup job is not implemented yet.
