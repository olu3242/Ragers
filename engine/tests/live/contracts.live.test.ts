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
import { publicResponsivenessFor } from '../../src/engines/responsiveness.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { RelationRow } from '../../src/ports/store.ts';

/**
 * The new contracts against a real database.
 *
 * What only Postgres can prove: the partial unique index on live disputes actually
 * arbitrates a race; the canonical relation key survives a round trip; the
 * responsiveness numerics come back as numbers rather than strings; and a
 * disputed-party update is refused by RLS and not merely by application code.
 */
describe(
  'engine contracts (live)',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-contract-${keyCounter}`;
    };

    before(async () => {
      h = await createPostgresHarness('contracts');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_contracts',
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
          input: { email, displayName: 'Contract Actor' },
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
            kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public',
          },
          actor,
          idempotencyKey: nextKey(),
        }),
        'create',
      );
      await settle();
      return created.experienceId;
    };

    test('concurrent dispute attempts from one person produce exactly one live dispute', async () => {
      const author = await signUp(`c-a-${Date.now()}@example.com`);
      const experienceId = await publish(author, 'Northwind Air never processed my refund.');

      const attempts = await Promise.all(
        Array.from({ length: 6 }, () =>
          engine.bus.dispatch({
            name: 'dispute.open',
            input: { experienceId, reason: 'account_inaccurate', detail: 'Not what happened.' },
            actor: author,
            idempotencyKey: nextKey(),
          }),
        ),
      );
      assert.equal(
        attempts.filter((result) => result.ok).length,
        1,
        'the partial unique index on live disputes arbitrates the race',
      );
      assert.equal(
        (await h.query<{ count: string }>(
          `select count(*)::text as count from experience_disputes where experience_id = $1`,
          [experienceId],
        ))[0]?.count,
        '1',
      );
    });

    test('the disputed party cannot update a dispute even at the SQL layer', async () => {
      const author = await signUp(`c-b-${Date.now()}@example.com`);
      const staff = await signUp(`c-s-${Date.now()}@example.com`);
      await h.query(`insert into organization_memberships (id, organization_id, actor_id, role)
        values ($1, 'org_northwind', $2, 'admin')`, [`mem_${staff.actorId}`, staff.actorId]);
      const experienceId = await publish(author, 'Northwind Air never processed my refund.');

      const opened = expect(
        await engine.bus.dispatch<unknown, { disputeId: string }>({
          name: 'dispute.open',
          input: { experienceId, reason: 'fix_not_delivered', detail: 'Still nothing.' },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'dispute',
      );

      // As a real client role with the staff identity: RLS scopes updates to the
      // raiser, so this writes nothing rather than being caught in application code.
      const outcome = await h.db.transaction(async (tx) => {
        await tx.query(`set local role authenticated`);
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [staff.actorId]);
        const rows = await tx.query(
          `update experience_disputes set status = 'declined' where id = $1 returning id`,
          [opened.disputeId],
        );
        return { ok: true as const, value: rows.length };
      });
      assert.equal(outcome.ok ? outcome.value : -1, 0, 'RLS refused the write');

      const row = await engine.store.disputes.get(opened.disputeId);
      assert.equal(row?.status, 'open', 'and the dispute is still open');
    });

    test('a relation round-trips on its canonical key, and re-asserting is refused', async () => {
      const a = await signUp(`c-r1-${Date.now()}@example.com`);
      const b = await signUp(`c-r2-${Date.now()}@example.com`);
      const observer = await signUp(`c-r3-${Date.now()}@example.com`);
      const first = await publish(a, 'Northwind Air never processed my refund.');
      const second = await publish(b, 'Northwind Air lost my bag last week.');

      expect(
        await engine.bus.dispatch({
          name: 'relation.assert',
          input: { fromExperienceId: first, toExperienceId: second, assertion: 'same_pattern' },
          actor: observer,
          idempotencyKey: nextKey(),
        }),
        'relate',
      );
      const reversed = await engine.bus.dispatch({
        name: 'relation.assert',
        input: { fromExperienceId: second, toExperienceId: first },
        actor: observer,
        idempotencyKey: nextKey(),
      });
      assert.equal(reversed.ok, false, 'the canonical pair makes both directions one assertion');

      const rows = await engine.store.relations.query([eq<RelationRow>('assertedBy', observer.actorId)]);
      assert.equal(rows.length, 1);
      // Canonicalised in storage, so the ordering survives the round trip.
      assert.ok((rows[0]?.fromExperienceId ?? '') <= (rows[0]?.toExperienceId ?? ''));
    });

    test('responsiveness numerics come back as numbers, and timings are withheld below the floor', async () => {
      const author = await signUp(`c-o-${Date.now()}@example.com`);
      const staff = await signUp(`c-os-${Date.now()}@example.com`);
      await h.query(`insert into organization_memberships (id, organization_id, actor_id, role)
        values ($1, 'org_northwind', $2, 'admin')`, [`mem_${staff.actorId}`, staff.actorId]);

      const experienceId = await publish(author, 'Northwind Air never processed my refund.');
      expect(
        await engine.bus.dispatch({
          name: 'normalization.confirm',
          input: { experienceId, fields: { entity: 'ent_northwind' } },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'confirm',
      );
      clock.advance(120_000);
      expect(
        await engine.bus.dispatch({
          name: 'organization.respond',
          input: { organizationId: 'org_northwind', experienceId, kind: 'acknowledge', body: 'Seen.' },
          actor: staff,
          idempotencyKey: nextKey(),
        }),
        'respond',
      );
      await settle();

      const snapshot = await engine.store.responsiveness.get('org_northwind');
      assert.ok(snapshot, 'a snapshot was written');
      for (const [name, value] of Object.entries(snapshot ?? {})) {
        if (name === 'id' || name === 'organizationId') continue;
        assert.equal(typeof value, 'number', `${name} must be a number, got ${typeof value}`);
      }
      // Arithmetic on a string concatenates, so prove it adds.
      assert.equal((snapshot?.responseRate ?? 0) + 1, 2);

      const view = await publicResponsivenessFor(engine, 'org_northwind');
      assert.equal(view?.insufficientSample, true);
      assert.equal(view?.medianFirstResponseMs, undefined, 'withheld below the floor');
    });

    test('a member cannot read a proposal; a moderator can', async () => {
      const member = await signUp(`c-m-${Date.now()}@example.com`);
      await h.query(`insert into intelligence_proposals
        (id, proposal_type, source_engine, target_engine, subject_id, summary, rationale, confidence,
         evidence_refs, correlation_id)
        values ('prp_live', 'review', 'E12', 'E4', 'exp_x', 's', 'r', 0.5, '[]'::jsonb, 'corr')`);

      const asActor = async (actorId: string): Promise<number> => {
        const outcome = await h.db.transaction(async (tx) => {
          await tx.query(`set local role authenticated`);
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
          const rows = await tx.query(`select * from intelligence_proposals`);
          return { ok: true as const, value: rows.length };
        });
        return outcome.ok ? outcome.value : 0;
      };

      assert.equal(await asActor(member.actorId), 0, 'a member sees no proposals');
      await h.query(`update actors set role = 'moderator' where id = $1`, [member.actorId]);
      assert.ok((await asActor(member.actorId)) > 0, 'a moderator does');
    });

    test('every new table has RLS, and no client role may delete a dispute or a relation', async () => {
      const withoutRls = await h.query<{ tablename: string }>(
        `select tablename from pg_tables t
         where schemaname = 'public'
           and tablename in ('experience_disputes','experience_relations','responsiveness_snapshots','intelligence_proposals')
           and not exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)`,
      );
      assert.deepEqual(withoutRls, []);

      const deletes = await h.query<{ table_name: string }>(
        `select table_name from information_schema.role_table_grants
         where table_name in ('experience_disputes','experience_relations')
           and grantee in ('anon','authenticated') and privilege_type = 'DELETE'`,
      );
      assert.deepEqual(deletes, [], 'a dispute is withdrawn, never deleted');
    });
  },
);
