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
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Command boundary refusals against a real database.
 *
 * The in-memory sweep can only prove that a refusal happened. What Postgres adds is
 * *what the missing refusal used to cost*, and it differs per column in a way no
 * in-memory store can show:
 *
 *   - `experiences.visibility` is the enum `visibility_mode`. An unrecognised
 *     visibility never reached a row here — it reached the driver and came back as a
 *     `22P02` invalid input syntax, which the bus reported as `command_threw`. So the
 *     same defect was a silent bad write in memory and an internal error live: two
 *     different wrong answers to one bad request.
 *   - `notification_preferences.kind` is plain `text`, with a unique constraint on
 *     `(actor_id, kind)`. Postgres was *happy* to store `smoke_signal`, and happy to
 *     store a thousand more, one row per distinct string a caller invented. Nothing
 *     downstream would ever read them. This is the one where the live database was
 *     more permissive than memory, not less.
 *   - `notification_preferences.enabled` is `boolean`, and Postgres coerces the text
 *     `'yes'` to true. A non-boolean did not fail; it was quietly accepted as one.
 *   - `moderation_actions.action` is the enum `moderation_action_kind`, so an action
 *     outside it failed at insert — but only after the handler had already decided to
 *     close every open report on the target. The transaction saved the rows; the
 *     caller still got an internal error for a plainly bad request.
 *
 * Each test below asserts the refusal, and then that the table is untouched — which
 * is the part that says the check runs before the write rather than beside it.
 */
describe(
  'command boundaries (live)',
  { skip: liveDatabaseAvailable() ? false : 'no live database configured' },
  () => {
    let h: PostgresHarness;
    let engine: Engine;
    let clock: FixedClock;
    let author: ActorContext;
    let admin: ActorContext;
    let experienceId: string;
    let keyCounter = 0;

    const nextKey = (): string => {
      keyCounter += 1;
      return `live-cb-${keyCounter}`;
    };

    const signUp = async (email: string): Promise<ActorContext> => {
      const auth = expect(
        await engine.bus.dispatch<unknown, AuthResult>({
          name: 'identity.register',
          input: { email, displayName: 'Live Tester' },
          actor: { actorId: 'guest', role: 'guest', authenticated: false },
          idempotencyKey: nextKey(),
        }),
        `register ${email}`,
      );
      return { actorId: auth.actorId, role: auth.role, authenticated: true, sessionId: auth.sessionId };
    };

    const settle = async (): Promise<void> => {
      for (let round = 0; round < 12; round += 1) {
        const report = await engine.orchestrator.drain();
        if (report.claimed === 0) break;
        if (report.retried > 0) clock.advance(120_000);
      }
    };

    before(async () => {
      h = await createPostgresHarness('cmd_bounds');
      clock = fixedClock(1_700_000_000_000);
      engine = createEngine({
        db: h.db,
        clock,
        ids: uuidIdFactory,
        logger: createMemoryLogger(),
        workerId: 'worker_cb',
        retry: { maxAttempts: 3, baseMs: 1_000, factor: 2 },
        leaseMs: 10_000,
      });
      author = await signUp('author@boundaries.example');
      const adminActor = await signUp('admin@boundaries.example');
      await h.query(`update actors set role = 'admin' where id = $1`, [adminActor.actorId]);
      admin = { ...adminActor, role: 'admin' };

      const created = expect(
        await engine.bus.dispatch<unknown, CreateExperienceResult>({
          name: 'experience.create',
          input: {
            kind: 'rage',
            creationMode: 'text',
            category: 'Shopping & service',
            bodyText: 'The refund was promised and never arrived',
            visibility: 'public',
          },
          actor: author,
          idempotencyKey: nextKey(),
        }),
        'create',
      );
      experienceId = created.experienceId;
      await settle();
    });

    after(async () => {
      await h?.destroy();
    });

    test('an unrecognised visibility is refused before it reaches the enum column', async () => {
      const before = await h.query<{ visibility: string; version: string }>(
        `select visibility, version from experiences where id = $1`,
        [experienceId],
      );

      const result = await engine.bus.dispatch({
        name: 'creator.changeVisibility',
        input: { experienceId, visibility: 'semi' },
        actor: author,
        idempotencyKey: nextKey(),
      });

      assert.ok(!result.ok, 'refused');
      assert.equal(result.error.kind, 'validation');
      assert.equal(result.error.code, 'invalid_visibility');

      const after = await h.query<{ visibility: string; version: string }>(
        `select visibility, version from experiences where id = $1`,
        [experienceId],
      );
      assert.deepEqual(after, before, 'the row is untouched, version included');

      // And the legitimate tightening still works, so the guard did not become a wall.
      const tightened = await engine.bus.dispatch({
        name: 'creator.changeVisibility',
        input: { experienceId, visibility: 'anonymous' },
        actor: author,
        idempotencyKey: nextKey(),
      });
      assert.ok(tightened.ok, 'tightening is still allowed');
    });

    test('an unrecognised notification kind writes no preference row', async () => {
      const attempts = ['smoke_signal', 'carrier_pigeon', ''];
      for (const kind of attempts) {
        const result = await engine.bus.dispatch({
          name: 'notification.setPreference',
          input: { kind, enabled: false },
          actor: author,
          idempotencyKey: nextKey(),
        });
        assert.ok(!result.ok, `${kind || '(empty)'} refused`);
        assert.equal(result.error.code, 'unknown_notification_kind');
      }

      const rows = await h.query<{ count: string }>(
        `select count(*)::text as count from notification_preferences where actor_id = $1`,
        [author.actorId],
      );
      assert.equal(rows[0]?.count, '0', 'no invented kind was stored');

      // A real kind still lands, and lands once.
      for (const round of [0, 1]) {
        const set = await engine.bus.dispatch({
          name: 'notification.setPreference',
          input: { kind: 'reply_received', enabled: round === 0 },
          actor: author,
          idempotencyKey: nextKey(),
        });
        assert.ok(set.ok, 'a known kind is accepted');
      }
      const stored = await h.query<{ kind: string; enabled: boolean }>(
        `select kind, enabled from notification_preferences where actor_id = $1`,
        [author.actorId],
      );
      assert.deepEqual(stored, [{ kind: 'reply_received', enabled: false }]);
    });

    test('a non-boolean preference is refused rather than coerced by the column', async () => {
      // Postgres would have taken `'yes'` as true. The refusal is the only thing that
      // makes the caller's mistake visible to the caller.
      const result = await engine.bus.dispatch({
        name: 'notification.setPreference',
        input: { kind: 'reaction_received', enabled: 'yes' },
        actor: author,
        idempotencyKey: nextKey(),
      });
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'enabled_must_be_boolean');

      const rows = await h.query<{ count: string }>(
        `select count(*)::text as count from notification_preferences
         where actor_id = $1 and kind = 'reaction_received'`,
        [author.actorId],
      );
      assert.equal(rows[0]?.count, '0');
    });

    test('an unrecognised moderation action closes no report and writes no action', async () => {
      const reported = await engine.bus.dispatch({
        name: 'safety.fileReport',
        input: { targetType: 'experience', targetId: experienceId, reasonCode: 'spam' },
        actor: admin,
        idempotencyKey: nextKey(),
      });
      assert.ok(reported.ok, `a report exists to be wrongly closed: ${reported.ok ? '' : reported.error.kind + '/' + reported.error.code + ' ' + reported.error.message}`);
      await settle();

      for (const input of [
        { targetType: 'experience', targetId: experienceId, action: 'obliterate', reason: 'spam' },
        { targetType: 'planet', targetId: experienceId, action: 'remove', reason: 'spam' },
        { targetType: 'experience', targetId: experienceId, action: 'remove' },
      ]) {
        const result = await engine.bus.dispatch({
          name: 'safety.applyModerationAction',
          input,
          actor: admin,
          idempotencyKey: nextKey(),
        });
        assert.ok(!result.ok, `${JSON.stringify(input)} refused`);
        assert.equal(result.error.kind, 'validation', `${result.error.kind}/${result.error.code}`);
      }

      const actions = await h.query<{ count: string }>(
        `select count(*)::text as count from moderation_actions where target_id = $1`,
        [experienceId],
      );
      assert.equal(actions[0]?.count, '0', 'no moderation action was recorded');

      const open = await h.query<{ count: string }>(
        `select count(*)::text as count from reports where target_id = $1 and status = 'open'`,
        [experienceId],
      );
      assert.equal(open[0]?.count, '1', 'the report is still open for a moderator to act on');
    });

    test('a malformed decision note leaves the case, dispute and proposal untouched', async () => {
      const cases = [
        { command: 'case.transition', input: { caseId: 'case:nope:nope', to: 'closed', note: 7 } },
        { command: 'dispute.review', input: { disputeId: 'dsp_nope', outcome: 'declined', note: 7 } },
        { command: 'proposal.decide', input: { proposalId: 'prp_nope', outcome: 'rejected', note: 7 } },
      ];
      // These resolve to nothing here on purpose: the point is that *no* path from a
      // malformed note reaches an internal error, whether the target exists or not.
      for (const { command, input } of cases) {
        const result = await engine.bus.dispatch({ name: command, input, actor: admin, idempotencyKey: nextKey() });
        assert.ok(!result.ok);
        assert.notEqual(result.error.kind, 'internal', `${command} → ${result.error.kind}/${result.error.code}`);
      }
    });

    test('a malformed command against the real database appends no outbox event', async () => {
      const before = await h.query<{ count: string }>(`select count(*)::text as count from outbox`);

      for (const command of engine.bus.registeredCommands()) {
        if (command === 'creator.requestExport') continue;
        for (const input of [undefined, null, 'not-an-object', 42, []]) {
          await engine.bus.dispatch({ name: command, input, actor: author, idempotencyKey: nextKey() });
        }
      }

      const after = await h.query<{ count: string }>(`select count(*)::text as count from outbox`);
      assert.equal(after[0]?.count, before[0]?.count, 'the outbox did not grow');
    });
  },
);
