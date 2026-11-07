import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TransientJobError } from '../src/jobs/errors.ts';
import { assertDiskReserve, availableBytes } from '../src/media/disk.ts';

test('derivative work stops at the configured free-space reserve', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nix360-disk-'));
  try {
    if (availableBytes(workspace) === null) {
      // The platform cannot report free space; the guard deliberately does not
      // invent a value, so there is nothing meaningful to assert here.
      return;
    }

    assert.throws(
      () => assertDiskReserve({ dataDir: workspace, minFreeBytes: Number.MAX_SAFE_INTEGER }),
      (error: unknown) => error instanceof TransientJobError && /Insufficient free space/.test(error.message),
    );
    assert.doesNotThrow(() => assertDiskReserve({ dataDir: workspace, minFreeBytes: 0 }));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
