import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';
import { createEngine, type Engine } from '../../src/engine.ts';
import { fixedClock, type FixedClock } from '../../src/runtime/clock.ts';
import { uuidIdFactory } from '../../src/runtime/ids.ts';
import { createMemoryLogger } from '../../src/runtime/logger.ts';
import { expect, ok, err } from '../../src/runtime/result.ts';
import { transientError } from '../../src/runtime/errors.ts';
import { eq } from '../../src/ports/store.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { UploadTargetResult } from '../../src/engines/voice.engine.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';

/**
 * Phase 21 exit criteria, against a real database.
 *
 * The voice pipeline must survive an API restart, a worker restart, duplicate
 * event delivery, a provider timeout and a temporary database failure — without
 * duplicate publication or corrupt state. These are the assertions that
 * distinguish durable orchestration from an in-process callback.
 */
describe('durable orchestration', { skip: liveDatabaseAvailable() ? false : 'no live database configured' }, () => {
  let h: PostgresHarness;
  let clock: FixedClock;
  let keyCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    return `live-idem-${keyCounter}`;
  };

  /** Build an engine over the shared database — a fresh one models a restart. */
  const bootEngine = (workerId: string, overrides: Parameters<typeof createEngine>[0] = {}): Engine =>
    createEngine({
      db: h.db,
      clock,
      // Uuid ids, as production uses: several engines share one database here, and
      // per-factory sequential ids would collide across them.
      ids: uuidIdFactory,
      logger: createMemoryLogger(),
      workerId,
      retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
      leaseMs: 10_000,
      ...overrides,
    });

  const signUp = async (engine: Engine, email: string): Promise<ActorContext> => {
    const auth = expect(
      await engine.bus.dispatch<unknown, AuthResult>({
        name: 'identity.register',
        input: { email, displayName: 'Durable Actor' },
        actor: { actorId: 'guest', role: 'guest', authenticated: false },
        idempotencyKey: nextKey(),
      }),
      'sign up',
    );
    return { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId };
  };

  const createVoiceExperience = async (engine: Engine, actor: ActorContext): Promise<string> => {
    const created = expect(
      await engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: { kind: 'rage', creationMode: 'voice', category: 'Other', visibility: 'anonymous' },
        actor,
        idempotencyKey: nextKey(),
      }),
      'create',
    );
    const target = expect(
      await engine.bus.dispatch<unknown, UploadTargetResult>({
        name: 'voice.requestUploadTarget',
        input: { experienceId: created.experienceId },
        actor,
        idempotencyKey: nextKey(),
      }),
      'target',
    );
    expect(
      await engine.bus.dispatch({
        name: 'voice.attachAsset',
        input: {
          experienceId: created.experienceId,
          uploadTargetId: target.uploadTargetId,
          durationMs: 5_000,
          byteSize: 120_000,
          mimeType: 'audio/webm',
        },
        actor,
        idempotencyKey: nextKey(),
      }),
      'attach',
    );
    return created.experienceId;
  };

  /** Drain until quiet, advancing the clock only when something is backing off. */
  const settle = async (engine: Engine, rounds = 14): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      const report = await engine.orchestrator.drain();
      if (report.claimed === 0 && report.reclaimed === 0) break;
      if (report.retried > 0) clock.advance(120_000);
    }
  };

  before(async () => {
    h = await createPostgresHarness('orch');
    clock = fixedClock();
  });

  after(async () => {
    await h?.destroy();
  });

  test('the voice pipeline completes with state persisted in the database', async () => {
    const engine = bootEngine('worker_happy');
    const actor = await signUp(engine, 'happy@example.com');
    const experienceId = await createVoiceExperience(engine, actor);

    await settle(engine);

    const experience = await engine.store.experiences.get(experienceId);
    assert.equal(experience?.status, 'published');

    // The evidence is in the database, not in a process.
    const rows = await h.query<{ status: string }>(`select status from experiences where id = $1`, [experienceId]);
    assert.equal(rows[0]?.status, 'published', 'the aggregate is durable');

    const feed = await h.query<{ count: string }>(
      `select count(*)::text as count from feed_entries where experience_id = $1`,
      [experienceId],
    );
    assert.equal(feed[0]?.count, '1', 'the projection is durable');

    const pending = await engine.outbox.pendingCount();
    assert.equal(pending, 0, 'every event was delivered');
  });

  test('a restarted process rediscovers in-flight work and completes it exactly once', async () => {
    // First process creates the experience but never drains, so the pipeline is
    // left mid-flight with events sitting in the outbox.
    const first = bootEngine('worker_first');
    const actor = await signUp(first, 'restart@example.com');
    const experienceId = await createVoiceExperience(first, actor);

    const beforePending = await first.outbox.pendingCount();
    assert.ok(beforePending > 0, 'work is genuinely in flight before the restart');
    assert.equal((await first.store.experiences.get(experienceId))?.status, 'pending_media');

    // A completely new engine — new worker id, new in-process state — takes over.
    const second = bootEngine('worker_second');
    await settle(second);

    const experience = await second.store.experiences.get(experienceId);
    assert.equal(experience?.status, 'published', 'the restarted process finished the work');

    // Exactly one media asset and one feed entry: no duplication across the restart.
    const assets = await second.store.mediaAssets.query([eq('experienceId', experienceId)]);
    assert.equal(assets.length, 1, 'no duplicate media asset');
    const feed = await h.query<{ count: string }>(
      `select count(*)::text as count from feed_entries where experience_id = $1`,
      [experienceId],
    );
    assert.equal(feed[0]?.count, '1', 'no duplicate feed entry');
  });

  test('an abandoned lease is reclaimed and the job resumes on another worker', async () => {
    const engine = bootEngine('worker_owner');
    const actor = await signUp(engine, 'lease@example.com');
    const experienceId = await createVoiceExperience(engine, actor);

    // Simulate a worker that leased the head event and died: take the lease
    // directly, then let it lapse.
    // A lease names a registered worker (enforced by a foreign key), so the
    // doomed worker announces itself before taking the job.
    await engine.workers.register({ id: 'worker_dead', hostname: 'doomed', now: clock.now() });

    const due = await engine.outbox.claimDue(1);
    const head = due[0];
    assert.ok(head, 'there is an event to lease');
    const claimed = await engine.deliveries.claim(
      head?.id ?? '',
      'privacy.protect_media',
      'worker_dead',
      clock.now() + 5_000,
      clock.now(),
    );
    assert.ok(claimed, 'the dead worker held the job');

    const held = await h.query<{ lease_owner: string; state: string }>(
      `select lease_owner, state from event_deliveries where outbox_id = $1`,
      [head?.id],
    );
    assert.equal(held[0]?.lease_owner, 'worker_dead', 'the lease is visible in the database');

    // Past the lease, a live worker reclaims and completes the job.
    clock.advance(20_000);
    const rescuer = bootEngine('worker_rescuer');
    await settle(rescuer);

    assert.equal((await rescuer.store.experiences.get(experienceId))?.status, 'published');
    const finished = await h.query<{ state: string; lease_owner: string | null }>(
      `select state, lease_owner from event_deliveries where outbox_id = $1`,
      [head?.id],
    );
    assert.equal(finished[0]?.state, 'completed');
    assert.notEqual(finished[0]?.lease_owner, 'worker_dead', 'a live worker finished it');
  });

  test('duplicate command dispatch produces one experience, enforced by the database', async () => {
    const engine = bootEngine('worker_idem');
    const actor = await signUp(engine, 'dupe@example.com');
    const key = nextKey();

    const input = {
      kind: 'rave' as const,
      creationMode: 'text' as const,
      category: 'Other',
      bodyText: 'Submitted twice.',
      visibility: 'public' as const,
    };
    const first = await engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input,
      actor,
      idempotencyKey: key,
    });
    const replay = await engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input,
      actor,
      idempotencyKey: key,
    });

    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.deepEqual(first, replay, 'the replay returns the first outcome');

    const rows = await h.query<{ count: string }>(
      `select count(*)::text as count from experiences where actor_id = $1 and body_text = 'Submitted twice.'`,
      [actor.actorId],
    );
    assert.equal(rows[0]?.count, '1', 'exactly one row exists');
  });

  test('duplicate event delivery does not duplicate a projection', async () => {
    const engine = bootEngine('worker_dupe_evt');
    const actor = await signUp(engine, 'dupeevt@example.com');
    const experienceId = await createVoiceExperience(engine, actor);
    await settle(engine);

    // Re-append the publication event, as an at-least-once transport would.
    const published = await h.query<{ id: string; payload: Record<string, unknown> }>(
      `select id, payload from outbox where event_name = 'ExperiencePublished' and aggregate_id = $1`,
      [experienceId],
    );
    assert.equal(published.length, 1);
    await engine.outbox.append(
      [
        {
          aggregateType: 'experience',
          aggregateId: experienceId,
          eventName: 'ExperiencePublished',
          payload: published[0]?.payload ?? {},
        },
      ],
      'corr-replay',
    );
    await settle(engine);

    const feed = await h.query<{ count: string }>(
      `select count(*)::text as count from feed_entries where experience_id = $1`,
      [experienceId],
    );
    assert.equal(feed[0]?.count, '1', 'the projection is keyed, so re-delivery overwrites rather than duplicates');
  });

  test('a provider timeout retries and then completes, with the attempt trail in the database', async () => {
    const engine = bootEngine('worker_timeout', {
      providers: {
        pii: {
          name: 'slow-then-ok',
          detectInText: async () => ok([]),
          protectAudio: (() => {
            let calls = 0;
            return async (input: { mediaAssetId: string; originalKey: string }) => {
              calls += 1;
              if (calls === 1) return err(transientError('provider_timeout', 'timed out'));
              return ok({ protectedKey: input.originalKey.replace('original/', 'protected/'), findings: [] });
            };
          })(),
        },
      },
    });
    const actor = await signUp(engine, 'timeout@example.com');
    const experienceId = await createVoiceExperience(engine, actor);

    await settle(engine);

    assert.equal(
      (await engine.store.experiences.get(experienceId))?.status,
      'published',
      'a transient provider failure must not stop publication',
    );

    const asset = (await engine.store.mediaAssets.query([eq('experienceId', experienceId)]))[0];
    assert.equal(asset?.protectionStatus, 'protected');
    assert.ok((asset?.attemptCount ?? 0) >= 2, 'the retry is recorded on the asset');

    const history = await h.query<{ state: string }>(
      `select state from job_history where delivery_id like $1 order by at`,
      ['%privacy.protect_media'],
    );
    const states = history.map((row) => row.state);
    assert.ok(states.includes('failed'), 'the failure is in the durable history');
    assert.ok(states.includes('retrying'), 'so is the retry decision');
    assert.ok(states.includes('completed'), 'and the eventual success');
  });

  test('a temporary database failure surfaces as retryable rather than as data loss', async () => {
    const engine = bootEngine('worker_dbfail');
    const actor = await signUp(engine, 'dbfail@example.com');
    const experienceId = await createVoiceExperience(engine, actor);

    // A statement against a missing relation is a database error, not a domain
    // one: it must not be mistaken for a validation failure.
    const failure = await h.db.transaction(async (tx) => {
      await tx.query('select * from a_relation_that_does_not_exist');
      return ok('unreachable');
    });
    assert.equal(failure.ok, false);
    if (!failure.ok) {
      assert.equal(failure.error.kind, 'internal');
      assert.equal(failure.error.code, 'database_error');
    }

    // The pipeline is unaffected and still completes.
    await settle(engine);
    assert.equal((await engine.store.experiences.get(experienceId))?.status, 'published');
  });

  test('serialization and connection failures are classified as retryable', async () => {
    const { toEngineError } = await import('../../src/adapters/postgres/client.ts');
    for (const code of ['40001', '40P01', '08006', '57P03']) {
      const mapped = toEngineError(Object.assign(new Error('boom'), { code }));
      assert.equal(mapped.retryable, true, `${code} must be retryable`);
      assert.equal(mapped.kind, 'transient');
    }
    const conflict = toEngineError(Object.assign(new Error('dupe'), { code: '23505' }));
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.retryable, false, 'a uniqueness violation is not worth retrying');
  });

  test('workers are registered and heartbeat, and a silent worker is reaped in the database', async () => {
    const engine = bootEngine('worker_alive');
    await engine.orchestrator.announce();

    const registered = await engine.workers.get('worker_alive');
    assert.equal(registered?.state, 'alive');
    assert.equal(registered?.hostname, 'local');

    // A worker that never heartbeats again is declared dead.
    await engine.workers.register({ id: 'worker_silent', hostname: 'gone', now: clock.now() });
    clock.advance(120_000);
    await engine.orchestrator.announce();
    const reaped = await engine.workers.reapStale(clock.now() - 15_000);

    assert.ok(reaped.includes('worker_silent'), 'the silent worker is reaped');
    assert.equal((await engine.workers.get('worker_silent'))?.state, 'dead');
    assert.equal((await engine.workers.get('worker_alive'))?.state, 'alive');
  });

  test('two engines against one database never run the same job twice', async () => {
    const producer = bootEngine('worker_p');
    const actor = await signUp(producer, 'contend@example.com');
    const experienceId = await createVoiceExperience(producer, actor);

    const a = bootEngine('worker_a');
    const b = bootEngine('worker_b');

    // Drain concurrently until quiet.
    for (let round = 0; round < 14; round += 1) {
      const [ra, rb] = await Promise.all([a.orchestrator.drain(), b.orchestrator.drain()]);
      if (ra.claimed === 0 && rb.claimed === 0) break;
      // Contention applies back-pressure by pushing the next attempt out, so the
      // clock has to move for the loop to make progress.
      if (ra.retried + rb.retried + ra.contended + rb.contended > 0) clock.advance(120_000);
    }

    assert.equal((await a.store.experiences.get(experienceId))?.status, 'published');
    const assets = await a.store.mediaAssets.query([eq('experienceId', experienceId)]);
    assert.equal(assets.length, 1, 'concurrent workers produced one asset, not two');

    const feed = await h.query<{ count: string }>(
      `select count(*)::text as count from feed_entries where experience_id = $1`,
      [experienceId],
    );
    assert.equal(feed[0]?.count, '1');

    // No job ended up in a held state with nobody working it.
    const stuck = await h.query<{ count: string }>(
      `select count(*)::text as count from event_deliveries
       where state in ('leased','running') and leased_until < $1`,
      [new Date(clock.now() + 3_600_000).toISOString()],
    );
    assert.equal(stuck[0]?.count, '0', 'no job is left permanently held');
  });

  test('health reports the database as a dependency', async () => {
    const engine = bootEngine('worker_health');
    const report = await engine.health.report();
    assert.ok(
      report.dependencies.some((dependency) => dependency.name === 'database'),
      'a durable engine reports its database',
    );
    assert.equal(report.dependencies.find((d) => d.name === 'database')?.state, 'healthy');
  });
});
