import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresHarness,
  liveDatabaseAvailable,
  type PostgresHarness,
} from '../support/postgres-harness.ts';
import { createEngine } from '../../src/engine.ts';
import { createDb } from '../../src/adapters/postgres/client.ts';
import { GUEST } from '../../src/runtime/authz.ts';
import { createMemoryLogger } from '../../src/runtime/logger.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';

/**
 * RC3 Batch 1: what a hosted deployment has to be true of, proved against a real database.
 *
 * These are the claims the release contract's `DEPLOYMENT_READY` and `SECURITY_READY` dimensions
 * will eventually want hosted evidence for. **Nothing here is hosted evidence.** It is the half
 * that can be certified without a target: that the schema, the credential and the composition root
 * behave against Postgres rather than against the in-memory adapters, and that the failure modes a
 * deployment actually hits are refusals rather than silent wrong answers.
 *
 * The distinction matters because it is exactly the one RC2's ledger exists to hold. A gate that
 * passed here and were reported as `DEPLOYMENT_READY` would be certifying a laptop.
 */
describe('deployment readiness against a live database', { skip: !liveDatabaseAvailable() }, () => {
  let h: PostgresHarness;

  before(async () => {
    h = await createPostgresHarness('deployment');
    for (const [id, role] of [
      ['dep_member', 'member'],
      ['dep_mod', 'moderator'],
      ['dep_admin', 'admin'],
    ] as const) {
      await h.query(
        `insert into actors (id, email, auth_provider, display_name, default_visibility, role, status)
         values ($1, $2, 'password', $1, 'public', $3, 'active') on conflict (id) do nothing`,
        [id, `${id}@example.com`, role],
      );
    }
  });
  after(async () => {
    await h?.destroy();
  });

  const as = async <R extends Record<string, unknown>>(
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<readonly R[] | 'refused'> => {
    const result = await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId ?? '']);
      return { ok: true as const, value: await tx.query<R>(sql, params) };
    });
    return result.ok ? result.value : 'refused';
  };

  const unreadable = async (
    actorId: string | undefined,
    role: 'anon' | 'authenticated',
    sql: string,
  ): Promise<void> => {
    const result = await as(actorId, role, sql);
    // Either outcome is "no": the privilege is absent, or RLS returns nothing. Demanding one would
    // pass or fail on which mechanism happened to be used.
    if (result !== 'refused') assert.equal(result.length, 0, `expected nothing from: ${sql.slice(0, 60)}`);
  };

  /**
   * An engine standing in for one instance of a deployment.
   *
   * **The real clock and the real id factory, deliberately.** Every other suite injects a fixed
   * clock and sequential ids for determinism, and here that would defeat the whole test: two
   * engines with independent sequential factories both mint `actor_1`, so the second instance
   * collides on the primary key instead of behaving like a second instance. Two processes in a
   * deployment share a database and share nothing else, which is precisely what is being certified.
   */
  const engineOn = (url: string) =>
    createEngine({
      db: createDb({ connectionString: url }),
      logger: createMemoryLogger(),
      // No drain loop: these tests assert what is *in* the outbox, and a loop would race them.
      throttle: false,
    });

  // ── The credential table, against real grants ──────────────────────────
  test('no client role can read a credential, including the person it belongs to', async () => {
    await h.query(
      `insert into actor_credentials (actor_id, algorithm, params, salt, hash)
       values ('dep_member', 'scrypt', '{"N":32768,"r":8,"p":1,"keylen":64}',
               repeat('s', 44), repeat('h', 88))
       on conflict (actor_id) do nothing`,
    );

    // **Including the owner**, which is the part that looks wrong and is right: there is nothing in
    // this row a person could use. A hash they could read is a hash they could take elsewhere.
    for (const [actorId, role] of [
      ['dep_member', 'authenticated'],
      ['dep_mod', 'authenticated'],
      ['dep_admin', 'authenticated'],
      [undefined, 'anon'],
    ] as const) {
      await unreadable(actorId, role, 'select hash from actor_credentials');
      await unreadable(actorId, role, 'select salt from actor_credentials');
      // Not even the *existence* of a credential, which would say which accounts are half set up.
      await unreadable(actorId, role, 'select actor_id from actor_credentials');
    }

    // And no client role may write one, which would be setting somebody's password directly.
    const written = await as('dep_member', 'authenticated', `update actor_credentials set hash = 'x'`);
    if (written !== 'refused') {
      const rows = await h.query<{ hash: string }>(`select hash from actor_credentials where actor_id = 'dep_member'`);
      assert.notEqual(rows[0]?.hash, 'x', 'a client role cannot overwrite a credential');
    }
  });

  test('the credential survives the round trip through Postgres, parameters and all', async () => {
    /**
     * The specific failure this rules out: `params` is jsonb and `throttle_expires_at` is
     * timestamptz, and both are handled by convention in the adapter rather than by a mapping per
     * table. A jsonb column missing from the adapter's set writes an object where an array was
     * meant; a timestamp column outside the `_at` convention writes epoch milliseconds into a
     * timestamptz. Neither is an error — both are wrong values — so the round trip is asserted.
     */
    const engine = engineOn(h.connectionString);
    const password = 'a long enough passphrase for the floor';
    const registered = await engine.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input: { email: 'roundtrip@example.com', displayName: 'Roundtrip' },
      actor: GUEST,
      idempotencyKey: 'rc3-register-1',
    });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    const actorId = registered.value.actorId;

    const set = await engine.bus.dispatch({
      name: 'identity.setPassword',
      input: { password },
      actor: { actorId, role: 'member', authenticated: true },
      idempotencyKey: 'rc3-setpw-1',
    });
    assert.equal(set.ok, true);

    const stored = await engine.store.actorCredentials.get(actorId);
    assert.ok(stored, 'the credential is in Postgres');
    assert.deepEqual(stored?.params, { N: 32_768, r: 8, p: 1, keylen: 64 }, 'jsonb survives as an object');
    assert.equal(typeof stored?.createdAt, 'number', 'and timestamps come back as milliseconds');
    assert.ok((stored?.createdAt ?? 0) > 0, 'not zero, which is what a broken conversion produces');

    // The whole point: a *different engine process* on the same database can verify it. That is
    // what separates a credential from a value cached in one server's memory.
    const second = engineOn(h.connectionString);
    const signedIn = await second.bus.dispatch<unknown, AuthResult>({
      name: 'identity.authenticate',
      input: { email: 'roundtrip@example.com', password },
      actor: GUEST,
      idempotencyKey: 'rc3-signin-1',
    });
    assert.equal(signedIn.ok, true, 'a second process verifies the password the first one wrote');
    if (!signedIn.ok) return;
    assert.equal(signedIn.value.actorId, actorId);

    const wrong = await second.bus.dispatch({
      name: 'identity.authenticate',
      input: { email: 'roundtrip@example.com', password: 'not the passphrase at all' },
      actor: GUEST,
      idempotencyKey: 'rc3-signin-2',
    });
    assert.equal(wrong.ok, false);
  });

  test('a throttle written by one process is seen by another', async () => {
    // Backoff held in process memory is no backoff at all behind two instances: an attacker would
    // simply be balanced onto the other one. So the counter lives in the row, and this asserts the
    // consequence rather than the implementation.
    const first = engineOn(h.connectionString);
    const registered = await first.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input: { email: 'throttled@example.com', displayName: 'Throttled' },
      actor: GUEST,
      idempotencyKey: 'rc3-register-2',
    });
    assert.ok(registered.ok);
    if (!registered.ok) return;
    const password = 'another sufficiently long passphrase';
    await first.bus.dispatch({
      name: 'identity.setPassword',
      input: { password },
      actor: { actorId: registered.value.actorId, role: 'member', authenticated: true },
      idempotencyKey: 'rc3-setpw-2',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await first.bus.dispatch({
        name: 'identity.authenticate',
        input: { email: 'throttled@example.com', password: `guess ${attempt}` },
        actor: GUEST,
        idempotencyKey: `rc3-guess-${attempt}`,
      });
    }

    const second = engineOn(h.connectionString);
    const credential = await second.store.actorCredentials.get(registered.value.actorId);
    assert.ok((credential?.failedAttempts ?? 0) >= 5, 'the other process sees the failures');
    assert.notEqual(credential?.throttleExpiresAt, undefined, 'and the window it earned');

    // Even the correct password is refused while the window holds — from the second process.
    const correct = await second.bus.dispatch({
      name: 'identity.authenticate',
      input: { email: 'throttled@example.com', password },
      actor: GUEST,
      idempotencyKey: 'rc3-correct-1',
    });
    assert.equal(correct.ok, false, 'the backoff is shared, not per instance');
  });

  // ── One database behind two processes ──────────────────────────────────
  test('idempotency is shared, so a retry that lands on another instance is still one intent', async () => {
    /**
     * The defect this rules out is the one the composition root already had once: with the
     * idempotency store in process memory, a client retry balanced onto a second instance looks
     * like a new intent. For a write that means the thing happens twice, and "twice" here means two
     * accounts, two corroborations, two of whatever was being retried.
     */
    const first = engineOn(h.connectionString);
    const second = engineOn(h.connectionString);
    const key = 'rc3-shared-idempotency';
    const input = { email: 'shared@example.com', displayName: 'Shared' };

    const once = await first.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input,
      actor: GUEST,
      idempotencyKey: key,
    });
    assert.equal(once.ok, true);
    if (!once.ok) return;

    const retried = await second.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input,
      actor: GUEST,
      idempotencyKey: key,
    });
    assert.equal(retried.ok, true, 'the retry is answered rather than refused as a duplicate');
    if (!retried.ok) return;
    assert.equal(retried.value.actorId, once.value.actorId, 'and it is the same actor, not a second one');

    const accounts = await h.query<{ n: string }>(
      `select count(*)::text as n from actors where email = 'shared@example.com'`,
    );
    assert.equal(accounts[0]?.n, '1', 'exactly one account exists');
  });

  test('the outbox is shared, so a worker in another process drains what the web tier wrote', async () => {
    // The other half of the composition-root defect: the web tier filled its own in-memory outbox
    // and a standalone worker drained a different, empty one. Nothing errored; events simply never
    // arrived, so projections stayed empty and the feed looked broken for no visible reason.
    const web = engineOn(h.connectionString);
    const registered = await web.bus.dispatch<unknown, AuthResult>({
      name: 'identity.register',
      input: { email: 'outboxed@example.com', displayName: 'Outboxed' },
      actor: GUEST,
      idempotencyKey: 'rc3-outbox-1',
    });
    assert.ok(registered.ok);
    if (!registered.ok) return;

    // Read the row directly rather than through `claimDue`, which would lease it and make the
    // assertion depend on what the web tier's own drain loop happened to have taken already.
    const rows = await h.query<{ n: string }>(
      `select count(*)::text as n from outbox where aggregate_id = $1`,
      [registered.value.actorId],
    );
    assert.notEqual(rows[0]?.n, '0', "the worker process can see the web tier's events");

    // And claiming from the second process really does hand it work, which is the behaviour the
    // in-memory version silently lacked: it drained an empty outbox of its own.
    const worker = engineOn(h.connectionString);
    const claimed = await worker.outbox.claimDue(100);
    assert.ok(claimed.length > 0, 'a separate process claims events it did not write');
  });

  // ── Wrong database ─────────────────────────────────────────────────────
  test('an unmigrated database refuses rather than appearing to work', async () => {
    /**
     * **The deployment mistake this catches is pointing at the wrong database.** A fresh or wrong
     * Postgres has no `actors` table, and the failure has to be loud: an engine that came up and
     * answered reads with nothing would look exactly like a product whose data had been lost.
     *
     * Asserted through a real dispatch rather than a connection check, because connecting succeeds
     * — it is the first query that fails, which is precisely why a startup ping is not enough.
     */
    const scratch = `ragers_rc3_unmigrated_${Date.now()}`;
    await h.query(`create database ${scratch}`);
    try {
      const url = new URL(h.connectionString);
      url.pathname = `/${scratch}`;
      const engine = engineOn(url.toString());
      const attempt = await engine.bus.dispatch({
        name: 'identity.register',
        input: { email: 'wrongdb@example.com', displayName: 'Wrong' },
        actor: GUEST,
        idempotencyKey: 'rc3-wrongdb-1',
      });
      assert.equal(attempt.ok, false, 'the wrong database is an error, not an empty success');
      if (attempt.ok) return;

      /**
       * **It must not read as a domain refusal, and it must be retryable.**
       *
       * "That account cannot be registered" would send an operator looking at the account rather
       * than at the connection string. And a non-retryable refusal would be recorded against the
       * idempotency key, so the same request would keep returning the same wrong answer after the
       * database was fixed.
       *
       * This assertion is also how a real defect surfaced: the reservation ran outside the bus's
       * `try`, so a missing relation **threw past `dispatch` entirely**. In a worker that is a dead
       * worker rather than a failed command. The quota charge immediately below it was already
       * guarded for exactly this reason, with a comment saying so; the reservation was not.
       */
      assert.notEqual(attempt.error.code, 'registration_unavailable', 'not a domain refusal');
      assert.equal(attempt.error.kind, 'transient', 'it reads as the dependency failure it is');
      assert.equal(attempt.error.retryable, true, 'and the caller is told to come back');
    } finally {
      await h.query(`drop database if exists ${scratch}`);
    }
  });

  test('every RC3 relation the adapter names exists, and carries row level security', async () => {
    // The schema guard in the unit suite compares the adapter's relations to the migrations. This
    // is the live half: the relation is really there, and RLS is really on. A table created without
    // it would be world-readable the day a browser client appears, and the grants from migration
    // 0002 are not what anybody reads that day.
    const rows = await h.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relname = 'actor_credentials' and relnamespace = 'public'::regnamespace`,
    );
    assert.equal(rows.length, 1, 'actor_credentials exists');
    assert.equal(rows[0]?.relrowsecurity, true, 'with RLS enabled');

    // And no policy, which is the intended state: RLS on with no policy denies every client role.
    const policies = await h.query<{ n: string }>(
      `select count(*)::text as n from pg_policies where tablename = 'actor_credentials'`,
    );
    assert.equal(policies[0]?.n, '0', 'no policy, so no client role has a path to a row');
  });
});
