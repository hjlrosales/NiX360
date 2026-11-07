# ADR 0001 — Modular monolith on Node + Fastify + SQLite

Date: 2026-11-05
Status: Accepted (local implementation; NAS deployment unverified)

## Context

The library is a household-scale system on a single NAS. The roadmap forbids adding Redis, brokers, Kubernetes or a separate media server without measured need, and requires durable processing and reproducible migration.

## Decision

- One TypeScript codebase, run by Node 24+ with native type stripping (no backend bundler).
- Fastify for HTTP; Preact + Vite for the static SPA.
- SQLite through the built-in `node:sqlite` driver, in WAL mode, on a local filesystem.
- A `jobs` table as the queue; the worker is the same codebase started with `--worker`.
- Argon2id via prebuilt `@node-rs/argon2`; image processing via prebuilt `sharp`.

## Consequences

- No extra infrastructure, no native compilation for argon2/sharp, and one language end to end.
- SQLite serialises writes; all transactions are short and the worker is limited to one heavy job so the API stays responsive. If measured write contention appears, PostgreSQL remains the documented escape hatch.
- Runtime must be Node 24+ because the sources are TypeScript. The Docker image pins that.
- Worker concurrency is deliberately 1; scaling means more worker processes sharing the same SQLite file, which the claim query already supports.
