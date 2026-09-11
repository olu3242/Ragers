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
import { publicSignalFor } from '../../src/engines/signal.engine.ts';
import { internalTrustFor } from '../../src/engines/trust.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { ClusterMember } from '../../src/ports/store.ts';

/**
 * The intelligence chain against a real database.
 *
 * This is where the jsonb and numeric columns get exercised: `extracted`,
 * `confirmed`, `factors` and `geographic_concentration` are jsonb, and the whole
 * signal snapshot is numeric. Postgres returns numerics as strings, so a metric
 * that arrives as `"0.5"` rather than `0.5` still renders — and then silently
 * concatenates the first time anything adds to it. Batch A found three defects of
 * exactly this shape, none of which an in-memory test can see.
 */
describe(
  'intelligence chain (live)',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-intel-${keyCounter}`;
    };

    before(async () => {
      h = await createPostgresHarness('intel');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_intel',
        retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
        leaseMs: 10_000,
      });

      await h.query(`insert into entities (id, name, slug, kind) values
        ('ent_northwind', 'Northwind Air', 'northwind-air', 'organization')`);
      await h.query(`insert into entity_aliases (id, entity_id, alias) values
        ('ali_1', 'ent_northwind', 'Northwind Air')`);
      await h.query(`insert into issue_types (id, category_id, name, slug)
        select 'iss_refund', id, 'Refund not processed', 'refund-not-processed'
        from categories where slug = 'shopping-service'`);
    });

    after(async () => {
      await h?.destroy();
    });

    const settle = async (): Promise<void> => {
      for (let pass = 0; pass < 40; pass += 1) {
        await engine.orchestrator.drain();
        if ((await engine.outbox.pendingCount()) === 0) return;
      }
      throw new Error('the outbox never drained');
    };

    const signUp = async (email: string): Promise<ActorContext> => {
      const auth = expect(
        await engine.bus.dispatch<unknown, AuthResult>({
          name: 'identity.register',
          input: { email, displayName: 'Intel Actor' },
          actor: { actorId: 'guest', role: 'guest', authenticated: false },
          idempotencyKey: nextKey(),
        }),
        'sign up',
      );
      return { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId };
    };

    const publish = async (actor: ActorContext, bodyText: string): Promise<string> => {
      const created = expect(
        await engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: {
            kind: 'rage',
            creationMode: 'text',
            category: 'Shopping & service',
            bodyText,
            visibility: 'public',
          },
          actor,
          idempotencyKey: nextKey(),
        }),
        'create',
      );
      await settle();
      return created.experienceId;
    };

    const categoryId = async (): Promise<string> =>
      (await h.query<{ id: string }>(`select id from categories where slug = 'shopping-service'`))[0]?.id ?? '';

    test('extraction persists to jsonb and reads back as an object, not a string', async () => {
      const author = await signUp(`intel-a-${Date.now()}@example.com`);
      const experienceId = await publish(author, 'Northwind Air never processed my refund after three weeks.');

      const metadata = await engine.store.experienceMetadata.get(experienceId);
      assert.ok(metadata, 'metadata was written');
      assert.equal(typeof metadata?.extracted, 'object', 'jsonb must round-trip as an object');
      assert.equal(
        Array.isArray((metadata?.extracted as { suggestions?: unknown[] }).suggestions),
        true,
      );
      assert.deepEqual(metadata?.confirmed, {}, 'nothing is confirmed by extraction');
    });

    test('a confirmation clusters the experience and the numbers are numbers', async () => {
      const author = await signUp(`intel-b-${Date.now()}@example.com`);
      const claimant = await signUp(`intel-c-${Date.now()}@example.com`);
      const experienceId = await publish(author, 'Northwind Air never processed my refund after three weeks.');

      expect(
        await engine.bus.dispatch({
          name: 'normalization.confirm',
          input: {
            experienceId,
            fields: { entity: 'ent_northwind', category: await categoryId(), issueType: 'iss_refund' },
          },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'confirm',
      );
      await settle();

      const experience = await engine.store.experiences.get(experienceId);
      assert.ok(experience?.clusterId, 'the experience joined a cluster');

      const member = await engine.store.clusterMembers.queryOne([
        eq<ClusterMember>('experienceId', experienceId),
      ]);
      assert.equal(typeof member?.score, 'number', 'numeric score must not come back as a string');
      assert.equal(typeof member?.factors, 'object', 'factors jsonb must round-trip');

      expect(
        await engine.bus.dispatch({
          name: 'corroboration.create',
          input: { experienceId, type: 're_rage' },
          actor: claimant,
          idempotencyKey: nextKey(),
        }),
        'corroborate',
      );
      await settle();

      const signal = await publicSignalFor(engine, experience?.clusterId ?? '');
      assert.ok(signal, 'a snapshot exists');

      // The numeric round-trip is asserted on the stored row, which is where it
      // actually happens. The presentation type is checked separately below: the
      // rates are `Measure`s now, because a rate over one or two accounts is withheld
      // rather than published, and asserting `typeof rate === 'number'` would be
      // asserting the absence of that floor.
      const snapshot = await engine.store.signalSnapshots.get(`sig_${experience?.clusterId}_all`);
      assert.ok(snapshot, 'the snapshot row exists');
      for (const [name, value] of Object.entries(snapshot ?? {})) {
        if (typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value)) continue;
        if (['id', 'clusterId', 'window', 'geographicConcentration'].includes(name)) continue;
        assert.equal(typeof value, 'number', `${name} must be a number, got ${typeof value}`);
      }

      for (const [name, value] of Object.entries(signal ?? {})) {
        if (['clusterId', 'headline', 'topLocation', 'trending', 'responseRate', 'resolutionRate'].includes(name)) {
          continue;
        }
        assert.equal(typeof value, 'number', `${name} must be a number, got ${typeof value}`);
      }
      // Two accounts is below the floor, so the rates are withheld and carry no value
      // for a caller to read as a zero.
      assert.equal(signal?.responseRate.withheld, true);
      assert.equal('value' in (signal?.responseRate ?? {}), false);

      assert.equal(signal?.peopleAffected, 2, 'author plus corroborator');
      assert.equal(signal?.corroborations, 1);

      // Arithmetic on a string silently concatenates, so prove it adds.
      assert.equal((signal?.peopleAffected ?? 0) + 1, 3);
    });

    test('a snapshot is overwritten per window, not appended per delivery', async () => {
      const author = await signUp(`intel-d-${Date.now()}@example.com`);
      const experienceId = await publish(author, 'Northwind Air never processed my refund after three weeks.');
      expect(
        await engine.bus.dispatch({
          name: 'normalization.confirm',
          input: { experienceId, fields: { entity: 'ent_northwind', issueType: 'iss_refund' } },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'confirm',
      );
      await settle();

      const clusterId = (await engine.store.experiences.get(experienceId))?.clusterId ?? '';
      for (let round = 0; round < 3; round += 1) {
        await engine.outbox.append(
          [
            {
              aggregateType: 'cluster',
              aggregateId: clusterId,
              eventName: 'ClusterMembershipChanged',
              payload: { clusterId, experienceId },
            },
          ],
          `corr_repeat_${round}`,
        );
        await settle();
      }

      const snapshots = await h.query<{ count: string }>(
        `select count(*)::text as count from signal_snapshots where cluster_id = $1`,
        [clusterId],
      );
      assert.equal(snapshots[0]?.count, '1', 'history is windows, not deliveries');
    });

    test('trust confidences persist as numbers within bounds', async () => {
      const author = await signUp(`intel-e-${Date.now()}@example.com`);
      await publish(author, 'Northwind Air never processed my refund after three weeks.');
      await settle();

      const trust = await internalTrustFor(engine, author.actorId);
      assert.ok(trust, 'an assessment was written');
      for (const value of [
        trust?.accountConfidence,
        trust?.contributionConfidence,
        trust?.evidenceConfidence,
      ]) {
        assert.equal(typeof value, 'number', 'numeric(4,3) must not come back as a string');
        assert.ok((value ?? -1) >= 0 && (value ?? 2) <= 1);
      }
      assert.ok(Array.isArray(trust?.riskFlags), 'text[] must round-trip as an array');
    });

    test('a member cannot read a trust assessment; a moderator can', async () => {
      const author = await signUp(`intel-f-${Date.now()}@example.com`);
      await publish(author, 'Northwind Air never processed my refund after three weeks.');
      await settle();

      // Run as a real client role with a real actor identity, since a superuser
      // bypasses RLS and would prove nothing.
      const asActor = async (actorId: string, sql: string): Promise<number> => {
        const outcome = await h.db.transaction(async (tx) => {
          await tx.query(`set local role authenticated`);
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
          const rows = await tx.query(sql);
          return { ok: true as const, value: rows.length };
        });
        return outcome.ok ? outcome.value : 0;
      };

      assert.equal(
        await asActor(author.actorId, `select * from trust_assessments`),
        0,
        'a member sees no trust assessment, including their own — there is no public trust score',
      );

      await h.query(`update actors set role = 'moderator' where id = $1`, [author.actorId]);
      assert.ok(
        (await asActor(author.actorId, `select * from trust_assessments`)) > 0,
        'a moderator can read what the trust layer is for',
      );
    });

    test('evidence originals are withheld from every client role', async () => {
      const columns = await h.query<{ column_name: string }>(
        `select column_name from information_schema.column_privileges
         where table_name = 'evidence' and grantee in ('anon','authenticated')
           and privilege_type = 'SELECT' and column_name = 'original_key'`,
      );
      assert.deepEqual(columns, [], 'evidence originals are unreadable on every client path');
    });
  },
);
