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
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { corroborationKey } from '../../src/engines/corroboration.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborateResult } from '../../src/engines/corroboration.engine.ts';
import type { CorroborationRow } from '../../src/ports/store.ts';

/**
 * "One person, one corroboration" under real concurrency.
 *
 * The in-memory adapter can only simulate a race between interleaved promises;
 * Postgres has to arbitrate genuinely simultaneous statements across pooled
 * connections. Since a corroboration count is a count of *people*, this is the
 * invariant that decides whether the number can be trusted at all — so it is
 * asserted against the database that will actually hold it.
 */
describe('corroboration concurrency', { skip: liveDatabaseAvailable() ? false : 'no live database configured' }, () => {
  let h: PostgresHarness;
  let engine: Engine;
  let clock: FixedClock;
  let keyCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    return `live-cor-${keyCounter}`;
  };

  before(async () => {
    h = await createPostgresHarness('corcc');
    clock = fixedClock(1_700_000_000_000);
    engine = createEngine({
      db: h.db,
      clock,
      ids: uuidIdFactory,
      logger: createMemoryLogger(),
      workerId: 'worker_cor',
      retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
      leaseMs: 10_000,
    });
  });

  after(async () => {
    await h?.destroy();
  });

  const signUp = async (email: string): Promise<ActorContext> => {
    const auth = expect(
      await engine.bus.dispatch<unknown, AuthResult>({
        name: 'identity.register',
        input: { email, displayName: 'Concurrent Actor' },
        actor: { actorId: 'guest', role: 'guest', authenticated: false },
        idempotencyKey: nextKey(),
      }),
      'sign up',
    );
    return { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId };
  };

  const publish = async (actor: ActorContext): Promise<string> => {
    const created = expect(
      await engine.bus.dispatch<unknown, CreateExperienceResult>({
        name: 'experience.create',
        input: {
          kind: 'rage',
          creationMode: 'text',
          category: 'Shopping & service',
          bodyText: 'The refund never arrived.',
          visibility: 'public',
        },
        actor,
        idempotencyKey: nextKey(),
      }),
      'create',
    );
    // Publication is a consumer, so drain until the row is published rather than
    // assuming the create command left it that way.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await engine.orchestrator.drain();
      const row = await engine.store.experiences.get(created.experienceId);
      if (row?.status === 'published') return created.experienceId;
    }
    throw new Error('experience never reached published');
  };

  /**
   * Drain until nothing is pending. One pass claims at most one event per
   * aggregate, so a single drain is not the same thing as "the system has caught
   * up" — asserting on a projection after one pass tests the drain, not the
   * projection.
   */
  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 25; pass += 1) {
      await engine.orchestrator.drain();
      if ((await engine.outbox.pendingCount()) === 0) return;
    }
    throw new Error('the outbox never drained');
  };

  const corroborate = (actor: ActorContext, experienceId: string) =>
    engine.bus.dispatch<unknown, CorroborateResult>({
      name: 'corroboration.create',
      input: { experienceId, type: 're_rage' },
      actor,
      // A distinct key per attempt on purpose: idempotency must not be what
      // saves the invariant, because a real client racing itself sends distinct
      // requests.
      idempotencyKey: nextKey(),
    });

  test('eight simultaneous claims from one person produce exactly one corroboration', async () => {
    const author = await signUp(`author-${Date.now()}@example.com`);
    const claimant = await signUp(`claimant-${Date.now()}@example.com`);
    const experienceId = await publish(author);

    const results = await Promise.all(Array.from({ length: 8 }, () => corroborate(claimant, experienceId)));

    const won = results.filter((result) => result.ok);
    assert.equal(won.length, 1, 'exactly one of eight simultaneous claims may win');

    for (const lost of results.filter((result) => !result.ok)) {
      assert.equal(
        lost.ok === false ? lost.error.code : '',
        'already_corroborated',
        'a loser is told it lost, not handed an internal error',
      );
    }

    const rows = await engine.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experienceId),
    ]);
    assert.equal(rows.length, 1, 'nobody can manufacture corroborations by racing');
    assert.equal(rows[0]?.id, corroborationKey(experienceId, claimant.actorId), 'keyed on the natural pair');

    await settle();
    const counters = await engine.store.counters.get(experienceId);
    assert.equal(counters?.reRageCount, 1, 'the public count matches the rows');
    assert.equal(counters?.corroboratorCount, 1);
  });

  test('many people claiming at once all succeed, and the count is the number of people', async () => {
    const author = await signUp(`author2-${Date.now()}@example.com`);
    const experienceId = await publish(author);
    const claimants = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => signUp(`crowd-${index}-${Date.now()}@example.com`)),
    );

    const results = await Promise.all(claimants.map((actor) => corroborate(actor, experienceId)));
    assert.equal(results.filter((result) => result.ok).length, 6, 'distinct people are not in competition');

    assert.equal(
      await engine.store.corroborations.countWhere([
        eq<CorroborationRow>('experienceId', experienceId),
        eq<CorroborationRow>('status', 'active'),
      ]),
      6,
    );
  });

  test('a retraction and a simultaneous re-claim still leave one row', async () => {
    const author = await signUp(`author3-${Date.now()}@example.com`);
    const claimant = await signUp(`reclaim-${Date.now()}@example.com`);
    const experienceId = await publish(author);

    const first = expect(await corroborate(claimant, experienceId), 'first claim');
    expect(
      await engine.bus.dispatch<unknown, { retracted: true }>({
        name: 'corroboration.retract',
        input: { corroborationId: first.corroborationId },
        actor: claimant,
        idempotencyKey: nextKey(),
      }),
      'retract',
    );

    const again = await Promise.all(Array.from({ length: 4 }, () => corroborate(claimant, experienceId)));
    assert.equal(again.filter((result) => result.ok).length, 1, 'changing your mind back is also one claim');

    const rows = await engine.store.corroborations.query([
      eq<CorroborationRow>('experienceId', experienceId),
    ]);
    assert.equal(rows.length, 1, 'the row was reused, not duplicated');
    assert.equal(rows[0]?.status, 'active');
    assert.equal(rows[0]?.retractedAt, undefined, 're-claiming clears the retraction, it does not leave it dated');
  });
});
