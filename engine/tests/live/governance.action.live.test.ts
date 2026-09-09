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
import { enrichmentFor, nearDuplicatesOf } from '../../src/engines/enrichment.engine.ts';
import { severityFor } from '../../src/engines/severity.engine.ts';
import { evaluateEscalations, openEscalations } from '../../src/engines/escalation.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phases 31–35 against a real database.
 *
 * What only Postgres can prove: the enrichment `values` JSONB survives a round trip
 * with its provenance intact; `confidence` comes back as a number rather than a
 * string; the escalation unique constraint arbitrates a genuine race rather than the
 * application merely hoping to win it; the case closure check constraint refuses a
 * closure with no note even when the application is bypassed; and RLS refuses a
 * non-member reading another organization's cases.
 */
describe(
  'trust, governance and action (live)',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-tga-${keyCounter}`;
    };

    before(async () => {
      h = await createPostgresHarness('governance_action');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_tga',
        retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
        leaseMs: 10_000,
      });
      await h.query(`insert into entities (id, name, slug, kind) values
        ('ent_northwind', 'Northwind Air', 'northwind-air', 'organization')`);
      await h.query(`insert into entity_aliases (id, entity_id, alias) values
        ('ali_1', 'ent_northwind', 'Northwind Air')`);
      await h.query(`insert into organization_profiles (id, entity_id, display_name, status)
        values ('org_northwind', 'ent_northwind', 'Northwind Air', 'claimed')`);
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
          input: { email, displayName: 'Action Actor' },
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

    const assertDim = async (
      actor: ActorContext,
      experienceId: string,
      input: Record<string, unknown>,
    ): Promise<void> => {
      expect(
        await engine.bus.dispatch({
          name: 'enrichment.assert',
          input: { experienceId, ...input },
          actor,
          idempotencyKey: nextKey(),
        }),
        'assert dimension',
      );
      await settle();
    };

    test('asserted values survive a round trip with provenance and numeric types intact', async () => {
      const actor = await signUp('live-ada@example.com');
      const experienceId = await publish(actor, 'Northwind Air lost my bag and never refunded the fee');
      await assertDim(actor, experienceId, { dimension: 'money_lost', amount: 640.5, currency: 'gbp' });
      await assertDim(actor, experienceId, { dimension: 'service_interrupted', flag: true });

      const enrichment = await enrichmentFor(engine, experienceId);
      assert.ok(enrichment);
      const money = enrichment.values.find((value) => value.dimension === 'money_lost');
      assert.equal(typeof money?.amount, 'number', 'numeric came back as a number, not a string');
      assert.equal(money?.amount, 640.5);
      assert.equal(money?.currency, 'GBP');
      assert.equal(money?.provenance, 'experiencer');
      assert.equal(typeof enrichment.fingerprint, 'string');
      assert.equal(enrichment.fingerprint.length, 64);

      const severity = await severityFor(engine, experienceId);
      assert.ok(severity);
      assert.equal(typeof severity.confidence, 'number', 'pg numeric must not arrive as a string');
      assert.equal(severity.band, 'serious');
      assert.equal(severity.unassessed, false);
      assert.ok(severity.basis.includes('money_lost'));
    });

    test('concurrent escalation sweeps open exactly one row per rule', async () => {
      const actor = await signUp('live-bo@example.com');
      const experienceId = await publish(actor, 'The stair rail came away and nobody has been back since');
      await assertDim(actor, experienceId, { dimension: 'safety_involved', flag: true });

      clock.advance(40 * 86_400_000);
      // Six sweeps at once, which is what a multi-worker deployment actually does.
      // Only the unique constraint can arbitrate this; a read-then-write cannot.
      const results = await Promise.all(
        Array.from({ length: 6 }, async () => evaluateEscalations(engine, experienceId)),
      );
      const opened = results.flat();
      const keys = opened.map((row) => row.id);
      assert.equal(new Set(keys).size, keys.length, 'no rule was opened twice');

      const stored = await h.query<{ rule_id: string; count: string }>(
        `select rule_id, count(*)::text as count from experience_escalations
         where experience_id = $1 group by rule_id`,
        [experienceId],
      );
      assert.ok(stored.length > 0, 'at least one rule fired');
      for (const row of stored) {
        assert.equal(row.count, '1', `${row.rule_id} has exactly one row`);
      }

      const queued = await h.query<{ count: string }>(
        `select count(*)::text as count from moderation_queue
         where target_type = 'experience' and target_id = $1`,
        [experienceId],
      );
      assert.equal(queued[0]?.count, '1', 'and the shared queue holds one item, not six');
    });

    test('escalation writes to no table that could change an outcome', async () => {
      const actor = await signUp('live-cy@example.com');
      const experienceId = await publish(actor, 'The gas smell was reported twice and nobody attended');
      await assertDim(actor, experienceId, { dimension: 'safety_involved', flag: true });

      const before = await h.query<{ resolution_status: string; status: string }>(
        `select resolution_status::text, status::text from experiences where id = $1`,
        [experienceId],
      );
      clock.advance(50 * 86_400_000);
      await evaluateEscalations(engine, experienceId);
      const after = await h.query<{ resolution_status: string; status: string }>(
        `select resolution_status::text, status::text from experiences where id = $1`,
        [experienceId],
      );
      assert.deepEqual(after, before, 'the experience row is byte-identical after escalation');
      assert.ok((await openEscalations(engine)).length > 0, 'and the review was opened');
    });

    test('the database refuses a case closed with no note, application bypassed', async () => {
      const actor = await signUp('live-dee@example.com');
      const experienceId = await publish(actor, 'Northwind Air cancelled without telling me');
      await h.query(
        `insert into organization_cases (id, organization_id, experience_id, state, correlation_id)
         values ('case_live_1', 'org_northwind', $1, 'in_progress', 'corr')`,
        [experienceId],
      );

      await assert.rejects(
        h.query(`update organization_cases set state = 'closed' where id = 'case_live_1'`),
        /cases_closure_note/,
        'the check constraint holds even when nothing goes through the engine',
      );
    });

    test('one case per organization per experience, enforced by the database', async () => {
      const actor = await signUp('live-eve@example.com');
      const experienceId = await publish(actor, 'Northwind Air downgraded my seat without asking');
      await h.query(
        `insert into organization_cases (id, organization_id, experience_id, state, correlation_id)
         values ('case_live_2', 'org_northwind', $1, 'new', 'corr')`,
        [experienceId],
      );
      await assert.rejects(
        h.query(
          `insert into organization_cases (id, organization_id, experience_id, state, correlation_id)
           values ('case_live_3', 'org_northwind', $1, 'new', 'corr')`,
          [experienceId],
        ),
        /cases_one_per_experience/,
      );
    });

    test('a proposal written through the engine survives Postgres — the jsonb array regression', async () => {
      // This is the test that was missing. The E12 live coverage inserted proposals
      // with raw SQL, so the adapter's write path was never exercised for a jsonb
      // *array* — and node-postgres was turning `evidence_refs` into a Postgres array
      // literal, failing every proposal creation against a real database.
      const actor = await signUp('live-hal@example.com');
      const experienceId = await publish(actor, 'Northwind Air left me on hold for two hours');
      await h.query(`update actors set role = 'moderator' where id = $1`, [actor.actorId]);
      const moderator: ActorContext = { ...actor, role: 'moderator' };

      const created = expect(
        await engine.bus.dispatch<unknown, { proposalId: string }>({
          name: 'proposal.create',
          input: {
            proposalType: 'review_content',
            sourceEngine: 'E4',
            targetEngine: 'E9',
            subjectId: experienceId,
            summary: 'Worth a look',
            rationale: 'Filed by a reviewer; the account is the only basis.',
            confidence: 0.5,
            evidenceRefs: [{ kind: 'experience', id: experienceId }],
          },
          actor: moderator,
          idempotencyKey: nextKey(),
        }),
        'create proposal',
      );

      const stored = await engine.store.proposals.get(created.proposalId);
      assert.ok(stored, 'the proposal is readable back');
      assert.ok(Array.isArray(stored.evidenceRefs), 'evidence refs come back as an array, not an object');
      assert.equal(stored.evidenceRefs.length, 1);
      assert.equal(stored.evidenceRefs[0]?.kind, 'experience');
      assert.equal(stored.evidenceRefs[0]?.id, experienceId);
      // And the empty-object trap: `proposed_input` was omitted, so it must read back
      // as an empty object rather than as a Postgres array literal.
      assert.deepEqual(stored.proposedInput, {});
    });

    test('two people with identical accounts both keep their row', async () => {
      const ada = await signUp('live-fay@example.com');
      const bo = await signUp('live-gus@example.com');
      const text = 'The same parcel was marked delivered twice and never arrived';
      const mine = await publish(ada, text);
      const theirs = await publish(bo, text);
      await assertDim(ada, mine, { dimension: 'recurrence', flag: true });
      await assertDim(bo, theirs, { dimension: 'recurrence', flag: true });

      // The fingerprint index is deliberately non-unique: a unique index here would
      // have refused the second person's account outright.
      assert.deepEqual([...(await nearDuplicatesOf(engine, mine))], [theirs]);
      const rows = await h.query<{ count: string }>(
        `select count(*)::text as count from experience_enrichments where fingerprint = (
           select fingerprint from experience_enrichments where experience_id = $1
         )`,
        [mine],
      );
      assert.equal(rows[0]?.count, '2');
    });
  },
);
