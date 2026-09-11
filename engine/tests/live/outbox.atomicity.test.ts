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
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborationRow } from '../../src/ports/store.ts';

/**
 * The outbox is transactional with the state change, or it is not an outbox.
 *
 * If a handler's rows commit and its event does not, every projection derived
 * from that event is permanently behind — a corroboration that exists but whose
 * count never moves. The only way to know the two commit together is to fail
 * between them on purpose and check that neither survives.
 */
describe(
  'outbox atomicity',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-atomic-${keyCounter}`;
    };

    before(async () => {
      h = await createPostgresHarness('atomic');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_atomic',
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
          input: { email, displayName: 'Atomic Actor' },
          actor: { actorId: 'guest', role: 'guest', authenticated: false },
          idempotencyKey: nextKey(),
        }),
        'sign up',
      );
      return { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId };
    };

    const settle = async (): Promise<void> => {
      for (let pass = 0; pass < 25; pass += 1) {
        await engine.orchestrator.drain();
        if ((await engine.outbox.pendingCount()) === 0) return;
      }
      throw new Error('the outbox never drained');
    };

    test('a command writes its rows and its event in one transaction', async () => {
      const author = await signUp(`atomic-author-${Date.now()}@example.com`);
      const created = expect(
        await engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: {
            kind: 'rage',
            creationMode: 'text',
            category: 'Other',
            bodyText: 'Both or neither.',
            visibility: 'public',
          },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'create',
      );

      const events = await h.query<{ count: string }>(
        `select count(*)::text as count from outbox where aggregate_id = $1`,
        [created.experienceId],
      );
      assert.ok(
        Number(events[0]?.count ?? 0) >= 1,
        'the state change committed, so at least one event committed with it',
      );
      assert.ok(await engine.store.experiences.get(created.experienceId), 'and the row is there');
    });

    test('a failure after the rows are written rolls the rows back too', async () => {
      const author = await signUp(`atomic-rollback-${Date.now()}@example.com`);
      const claimant = await signUp(`atomic-claimant-${Date.now()}@example.com`);

      const created = expect(
        await engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: {
            kind: 'rage',
            creationMode: 'text',
            category: 'Other',
            bodyText: 'The refund never arrived.',
            visibility: 'public',
          },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'create',
      );
      await settle();

      // Break the outbox append specifically, so the handler's rows are already
      // written when the failure lands. This is the exact window a dual write
      // leaves open.
      await h.query(`alter table outbox add constraint refuse_everything check (false) not valid`);

      const attempt = await engine.bus.dispatch({
        name: 'corroboration.create',
        input: { experienceId: created.experienceId, type: 're_rage' },
        actor: claimant,
        idempotencyKey: nextKey(),
      });
      assert.equal(attempt.ok, false, 'the command must fail rather than half-succeed');

      await h.query(`alter table outbox drop constraint refuse_everything`);

      // The corroboration row must be gone with the event that never wrote.
      assert.equal(
        await engine.store.corroborations.countWhere([
          eq<CorroborationRow>('experienceId', created.experienceId),
        ]),
        0,
        'a claim whose event could not be recorded must not exist',
      );

      // And the system is still usable: the same claim now succeeds cleanly.
      const retried = await engine.bus.dispatch<unknown, { corroborationCount: number }>({
        name: 'corroboration.create',
        input: { experienceId: created.experienceId, type: 're_rage' },
        actor: claimant,
        idempotencyKey: nextKey(),
      });
      assert.equal(retried.ok, true, 'the rollback left nothing blocking a retry');
      await settle();
      assert.equal((await engine.store.counters.get(created.experienceId))?.reRageCount, 1);
    });
  },
);
