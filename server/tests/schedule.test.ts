import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createTestContext, type TestContext } from './helpers.ts';
import { enqueueDueScans } from '../src/media/scan.ts';
import { getRow, run } from '../src/db/sqlite.ts';

const ONE_HOUR = 60 * 60 * 1000;

describe('scheduled reconciliation scans', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('does nothing when the interval is zero', async () => {
    ctx = await createTestContext();
    assert.deepEqual(enqueueDueScans(ctx.db, 0), []);
  });

  it('queues a root whose last successful scan aged out', async () => {
    const old = new Date(Date.now() - 3 * ONE_HOUR).toISOString();
    run(ctx.db, `UPDATE library_roots SET last_success_at = ? WHERE id = 'test'`, old);

    const queued = enqueueDueScans(ctx.db, ONE_HOUR);
    assert.equal(queued.length, 1);

    const job = getRow<{ kind: string; status: string; payload: string }>(
      ctx.db,
      'SELECT kind, status, payload FROM jobs WHERE id = ?',
      queued[0]!,
    );
    assert.equal(job?.kind, 'scan_root');
    assert.equal(job?.status, 'queued');
    assert.deepEqual(JSON.parse(job?.payload ?? '{}'), { rootId: 'test' });

    assert.deepEqual(enqueueDueScans(ctx.db, ONE_HOUR), [], 'an active scan is not duplicated');
  });

  it('leaves a recently scanned root alone', async () => {
    run(ctx.db, `UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE kind = 'scan_root'`, new Date().toISOString());
    run(ctx.db, `UPDATE library_roots SET last_success_at = ? WHERE id = 'test'`, new Date().toISOString());

    assert.deepEqual(enqueueDueScans(ctx.db, ONE_HOUR), []);
  });

  it('queues a root that has never completed a scan', async () => {
    run(ctx.db, `UPDATE library_roots SET last_success_at = NULL WHERE id = 'test'`);
    assert.equal(enqueueDueScans(ctx.db, ONE_HOUR).length, 1);
  });
});
