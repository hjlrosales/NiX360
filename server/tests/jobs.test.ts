import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  claimNext,
  completeJob,
  enqueue,
  failJob,
  heartbeat,
  recoverExpiredLeases,
  retryJob,
  type Job,
} from '../src/jobs/queue.ts';
import { PermanentJobError } from '../src/jobs/errors.ts';
import { run } from '../src/db/sqlite.ts';

const PAST = new Date(Date.now() - 60_000).toISOString();

describe('durable jobs', () => {
  let ctx: TestContext;

  after(async () => {
    await ctx?.cleanup();
  });

  it('deduplicates active work but allows the same work later', async () => {
    ctx = await createTestContext();
    const first = enqueue(ctx.db, { kind: 'scan_root', dedupeKey: 'scan:test', payload: { rootId: 'test' } });
    assert.ok(first);
    assert.equal(enqueue(ctx.db, { kind: 'scan_root', dedupeKey: 'scan:test', payload: { rootId: 'test' } }), null);

    const job = claimNext(ctx.db, 'worker-a', 60_000);
    assert.ok(job);
    assert.equal(completeJob(ctx.db, job.id, 'worker-a'), true);
    assert.ok(enqueue(ctx.db, { kind: 'scan_root', dedupeKey: 'scan:test', payload: { rootId: 'test' } }));
  });

  it('claims a job exactly once and rejects stale lease owners', async () => {
    const job = claimNext(ctx.db, 'worker-a', 60_000);
    assert.ok(job);
    assert.equal(job?.status, 'running');
    assert.equal(job?.attempts, 1);
    assert.equal(claimNext(ctx.db, 'worker-b', 60_000), null);
    assert.equal(heartbeat(ctx.db, job!.id, 'worker-b', 60_000), false);
    assert.equal(heartbeat(ctx.db, job!.id, 'worker-a', 60_000), true);
    assert.equal(completeJob(ctx.db, job!.id, 'worker-b'), false);
    assert.equal(completeJob(ctx.db, job!.id, 'worker-a'), true);
    assert.equal(completeJob(ctx.db, job!.id, 'worker-a'), false, 'publication must not succeed twice');
  });

  it('retries transient failures with backoff and stops after max attempts', async () => {
    enqueue(ctx.db, { kind: 'thumbnail', dedupeKey: 'thumbnail:retry' });
    let job = claimNext(ctx.db, 'worker-a', 60_000) as Job;
    assert.ok(job);
    assert.equal(failJob(ctx.db, job, 'worker-a', new Error('storage hiccup')), 'retry_wait');
    assert.equal(claimNext(ctx.db, 'worker-b', 60_000), null, 'backoff must delay the retry');

    run(ctx.db, 'UPDATE jobs SET next_run_at = ? WHERE id = ?', PAST, job.id);
    job = claimNext(ctx.db, 'worker-b', 60_000) as Job;
    assert.ok(job);
    assert.equal(job.attempts, 2);

    let status = 'retry_wait';
    while (status === 'retry_wait') {
      status = failJob(ctx.db, job, 'worker-b', new Error('still failing'));
      if (status === 'retry_wait') {
        run(ctx.db, 'UPDATE jobs SET next_run_at = ? WHERE id = ?', PAST, job.id);
        job = claimNext(ctx.db, 'worker-b', 60_000) as Job;
      }
    }
    assert.equal(status, 'failed');
    assert.equal(claimNext(ctx.db, 'worker-b', 60_000), null);
  });

  it('fails permanently on unsupported input without retrying', async () => {
    enqueue(ctx.db, { kind: 'probe_media', dedupeKey: 'probe:permanent', mediaId: null });
    const job = claimNext(ctx.db, 'worker-a', 60_000) as Job;
    assert.ok(job);
    assert.equal(failJob(ctx.db, job, 'worker-a', new PermanentJobError('unsupported codec')), 'failed');
    assert.equal(claimNext(ctx.db, 'worker-a', 60_000), null);
  });

  it('recovers a crashed worker lease and requeues the job', async () => {
    enqueue(ctx.db, { kind: 'probe_media', dedupeKey: 'probe:recovery' });
    const job = claimNext(ctx.db, 'worker-a', 60_000) as Job;
    assert.ok(job);
    run(ctx.db, 'UPDATE jobs SET lease_expires_at = ? WHERE id = ?', PAST, job.id);

    assert.equal(recoverExpiredLeases(ctx.db), 1);
    const recovered = claimNext(ctx.db, 'worker-b', 60_000) as Job;
    assert.ok(recovered);
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.attempts, 2);
    assert.equal(completeJob(ctx.db, recovered.id, 'worker-b'), true);
  });

  it('retries a failed job manually and clears the error', async () => {
    enqueue(ctx.db, { kind: 'thumbnail', dedupeKey: 'thumbnail:manual' });
    const job = claimNext(ctx.db, 'worker-a', 60_000) as Job;
    failJob(ctx.db, job, 'worker-a', new PermanentJobError('decode failed'));

    assert.equal(retryJob(ctx.db, job.id), true);
    const retried = claimNext(ctx.db, 'worker-a', 60_000) as Job;
    assert.equal(retried.id, job.id);
    assert.equal(retried.attempts, 1);
    assert.equal(retried.last_error, null);
  });
});
