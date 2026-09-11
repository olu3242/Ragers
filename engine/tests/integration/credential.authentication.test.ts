import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { GUEST } from '../../src/runtime/authz.ts';
import type { AuthResult } from '../../src/engines/identity.engine.ts';
import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_MIN_LENGTH,
  THROTTLE_AFTER_FAILURES,
  createCredential,
  credentialCanBeRead,
  credentialCarriesARole,
  isThrottled,
  recordFailure,
  recordSuccess,
  spendVerificationWork,
  throttleWindowFor,
  verifyPassword,
} from '../../src/domain/credential.ts';

/**
 * RC3: the credential path.
 *
 * The thing being certified is narrow and load-bearing: **you cannot become an account without
 * proving you hold its password**, and the refusals give nothing away. Everything else here —
 * rotation, revocation, throttling — exists to make that first claim survive contact with an
 * attacker who has time.
 *
 * `SECURITY_READY` does not become plain `READY` on the strength of this file. These are local
 * proofs; the dimension asks for hosted ones, and `docs/releases/RAGERS_RC3_DEPLOYMENT.md` says
 * what those are.
 */

const PASSWORD = 'correct horse battery staple';
const memberOf = (actorId: string) => ({ actorId, role: 'member' as const, authenticated: true });

const setPassword = async (
  h: EngineHarness,
  actorId: string,
  password: string,
  currentPassword?: string,
) =>
  h.engine.bus.dispatch({
    name: 'identity.setPassword',
    input: currentPassword === undefined ? { password } : { password, currentPassword },
    actor: memberOf(actorId),
    idempotencyKey: h.nextKey(),
  });

const signIn = async (
  h: EngineHarness,
  email: string,
  password?: string,
) =>
  h.engine.bus.dispatch<unknown, AuthResult>({
    name: 'identity.authenticate',
    input: password === undefined ? { email } : { email, password },
    actor: GUEST,
    idempotencyKey: h.nextKey(),
  });

// ── The hash itself ──────────────────────────────────────────────────────
test('a stored credential contains nothing that could reconstruct the password', () => {
  const created = createCredential({ actorId: 'act_1', password: PASSWORD }, { now: 1_000 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const credential = created.value;

  // Serialised, because that is the form an attacker with the table would hold.
  const serialised = JSON.stringify(credential);
  assert.equal(serialised.includes(PASSWORD), false, 'the password is not in the row');
  assert.equal(serialised.includes('correct horse'), false, 'nor any part of it');
  assert.equal(credential.algorithm, 'scrypt');
  assert.deepEqual(credential.params, DEFAULT_SCRYPT_PARAMS, 'the cost travels with the row');

  assert.equal(verifyPassword(credential, PASSWORD), true);
  assert.equal(verifyPassword(credential, PASSWORD + ' '), false, 'a trailing space is a different password');
  assert.equal(verifyPassword(credential, PASSWORD.toUpperCase()), false);
  assert.equal(verifyPassword(credential, ''), false);
  assert.equal(verifyPassword(credential, undefined), false, 'a missing password is not a match');

  assert.equal(credentialCanBeRead(), false);
  assert.equal(credentialCarriesARole(), false);
});

test('two credentials for the same password share no hash', () => {
  // If they did, one cracked password would unlock every account that chose it, and a precomputed
  // table would be worth building. The salts are what stop that.
  const a = createCredential({ actorId: 'act_a', password: PASSWORD }, { now: 1 });
  const b = createCredential({ actorId: 'act_b', password: PASSWORD }, { now: 1 });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.value.salt, b.value.salt);
  assert.notEqual(a.value.hash, b.value.hash);
  // And each still verifies its own.
  assert.equal(verifyPassword(a.value, PASSWORD), true);
  assert.equal(verifyPassword(b.value, PASSWORD), true);
});

test('a password below the floor is refused, and the floor is length rather than composition', () => {
  const short = createCredential({ actorId: 'act_1', password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }, { now: 1 });
  assert.equal(short.ok, false);
  assert.equal(!short.ok && short.error.code, 'password_unacceptable');

  // `Passw0rd!` satisfies every composition rule anybody writes and is a terrible password; a long
  // passphrase of lowercase words satisfies none of them and is a good one. So length is the rule.
  const passphrase = createCredential({ actorId: 'act_1', password: 'four words are plenty' }, { now: 1 });
  assert.equal(passphrase.ok, true, 'a lowercase passphrase is acceptable');

  const enormous = createCredential({ actorId: 'act_1', password: 'x'.repeat(100_000) }, { now: 1 });
  assert.equal(enormous.ok, false, 'and a megabyte is a denial of service, not a strong password');
});

// ── Sign-in through the bus ──────────────────────────────────────────────
test('a valid credential signs in, and a wrong one does not', async () => {
  const h = createEngineHarness();
  const { auth } = await h.signUp('member@example.com', 'Member');
  assert.equal((await setPassword(h, auth.actorId, PASSWORD)).ok, true);

  const wrong = await signIn(h, 'member@example.com', 'incorrect horse battery staple');
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.error.code, 'authentication_failed');

  const right = await signIn(h, 'member@example.com', PASSWORD);
  assert.equal(right.ok, true, 'the right password signs in');
  if (!right.ok) return;
  assert.equal(right.value.actorId, auth.actorId);
  assert.equal(right.value.role, 'member', 'and the role comes from the actor, never from the credential');
});

test('an address alone mints nothing, for a member or for an admin', async () => {
  // The original defect, asserted at the level it mattered: privilege made it worse, so privilege
  // is what this checks.
  const h = createEngineHarness();
  const member = (await h.signUp('plain@example.com', 'Plain')).auth;
  const adminId = (await h.signUp('admin@example.com', 'Admin')).auth.actorId;
  await h.promote(adminId, 'admin');
  await setPassword(h, member.actorId, PASSWORD);
  await setPassword(h, adminId, 'a different long passphrase entirely', undefined);

  const before = (await h.engine.store.sessions.query([])).length;
  for (const email of ['plain@example.com', 'admin@example.com']) {
    const attempt = await signIn(h, email);
    assert.equal(attempt.ok, false, `${email} needs a password`);
    assert.equal(!attempt.ok && attempt.error.code, 'authentication_failed');
  }
  assert.equal(
    (await h.engine.store.sessions.query([])).length,
    before,
    'and the attempts minted no session',
  );

  // The admin's own password works, and does not work for the member's account.
  assert.equal((await signIn(h, 'admin@example.com', 'a different long passphrase entirely')).ok, true);
  assert.equal((await signIn(h, 'plain@example.com', 'a different long passphrase entirely')).ok, false);
});

test('signing in rotates the session, so a captured one stops working', async () => {
  /**
   * **The one recovery action a person can take unaided.** If sessions accumulated, somebody who
   * had lost a session cookie could do nothing about it but wait thirty days for it to expire.
   */
  const h = createEngineHarness();
  const { auth } = await h.signUp('rotate@example.com', 'Rotate');
  await setPassword(h, auth.actorId, PASSWORD);

  const first = await signIn(h, 'rotate@example.com', PASSWORD);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await signIn(h, 'rotate@example.com', PASSWORD);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(second.value.sessionId, first.value.sessionId, 'a new session, not the old one reused');

  const old = await h.engine.store.sessions.get(first.value.sessionId);
  assert.ok(old);
  assert.notEqual(old?.revokedAt, undefined, 'the earlier session is revoked');

  const current = await h.engine.store.sessions.get(second.value.sessionId);
  assert.equal(current?.revokedAt, undefined, 'and the one just issued is live');
});

test('a revoked session is not a credential, and revocation does not lock the account out', async () => {
  // Two separate facts, and conflating them is a real product failure: a person whose session was
  // revoked by a moderator must still be able to sign in, because revocation is not suspension.
  const h = createEngineHarness();
  const { auth } = await h.signUp('revoke@example.com', 'Revoke');
  await setPassword(h, auth.actorId, PASSWORD);
  const signedIn = await signIn(h, 'revoke@example.com', PASSWORD);
  assert.ok(signedIn.ok);
  if (!signedIn.ok) return;

  const revoked = await h.engine.bus.dispatch({
    name: 'identity.revokeSession',
    input: { sessionId: signedIn.value.sessionId },
    actor: memberOf(auth.actorId),
    idempotencyKey: h.nextKey(),
  });
  assert.equal(revoked.ok, true);
  assert.notEqual((await h.engine.store.sessions.get(signedIn.value.sessionId))?.revokedAt, undefined);

  const again = await signIn(h, 'revoke@example.com', PASSWORD);
  assert.equal(again.ok, true, 'the credential still works after a session is revoked');
});

test('a suspended account cannot sign in, and the refusal does not say so', async () => {
  const h = createEngineHarness();
  const { auth } = await h.signUp('suspended@example.com', 'Suspended');
  await setPassword(h, auth.actorId, PASSWORD);
  const actor = await h.engine.store.actors.get(auth.actorId);
  assert.ok(actor);
  await h.engine.store.actors.put({ ...actor!, status: 'suspended' });

  const attempt = await signIn(h, 'suspended@example.com', PASSWORD);
  assert.equal(attempt.ok, false);
  // Collapsed into the generic refusal on purpose. That an account is suspended is a moderation
  // fact about a person, and a sign-in form is not where a stranger learns it.
  assert.equal(!attempt.ok && attempt.error.code, 'authentication_failed');
});

// ── Rotation ─────────────────────────────────────────────────────────────
test('replacing a password requires the current one', async () => {
  /**
   * Without this a stolen session upgrades into permanent account ownership, which is strictly
   * worse than a stolen session: the owner can revoke a session and cannot revoke a password
   * somebody else chose.
   */
  const h = createEngineHarness();
  const { auth } = await h.signUp('rotate2@example.com', 'Rotate2');
  await setPassword(h, auth.actorId, PASSWORD);

  const withoutCurrent = await setPassword(h, auth.actorId, 'a brand new long passphrase');
  assert.equal(withoutCurrent.ok, false, 'a replacement with no current password is refused');
  assert.equal(!withoutCurrent.ok && withoutCurrent.error.code, 'authentication_failed');

  const wrongCurrent = await setPassword(h, auth.actorId, 'a brand new long passphrase', 'not the password');
  assert.equal(wrongCurrent.ok, false);

  const rotated = await setPassword(h, auth.actorId, 'a brand new long passphrase', PASSWORD);
  assert.equal(rotated.ok, true);

  assert.equal((await signIn(h, 'rotate2@example.com', PASSWORD)).ok, false, 'the old password stops working');
  assert.equal((await signIn(h, 'rotate2@example.com', 'a brand new long passphrase')).ok, true);

  // Rotation keeps the row's identity and its first-set date, so "when was this account's password
  // first set" survives every change.
  const credential = await h.engine.store.actorCredentials.get(auth.actorId);
  assert.ok(credential);
  assert.ok((credential?.rotatedAt ?? 0) >= (credential?.createdAt ?? 0));
});

test('nobody sets anybody else password, admin included', async () => {
  const h = createEngineHarness();
  const victim = (await h.signUp('victim2@example.com', 'Victim')).auth;
  const adminId = (await h.signUp('admin2@example.com', 'Admin')).auth.actorId;
  await h.promote(adminId, 'admin');
  await setPassword(h, victim.actorId, PASSWORD);

  /**
   * **The strongest form of this guarantee is that the command takes no target.** `setPassword`
   * has no `actorId` parameter at all: `resolveResource` returns the *caller* as the owner, so
   * there is no field through which an admin could name somebody else's account. A check that
   * compared a supplied target against the caller would be one refactor away from being wrong;
   * an absent parameter is not.
   *
   * So the admin below is not refused — they successfully set **their own** password, which is
   * what the input was always going to do. What must be true afterwards is that the victim's
   * credential is exactly as it was.
   */
  const asAdmin = await h.engine.bus.dispatch({
    name: 'identity.setPassword',
    input: { password: 'the admin chose this one', currentPassword: PASSWORD },
    actor: { actorId: adminId, role: 'admin', authenticated: true },
    idempotencyKey: h.nextKey(),
  });
  assert.equal(asAdmin.ok, true, "the admin set their own password, because that is the only row reachable");

  assert.equal((await signIn(h, 'victim2@example.com', PASSWORD)).ok, true, "the victim's password still works");
  assert.equal(
    (await signIn(h, 'victim2@example.com', 'the admin chose this one')).ok,
    false,
    'and the password the admin chose does not open the victim account',
  );
  // The write landed on the admin's own row, which is the other half: it did something, and the
  // something it did was scoped to the caller.
  assert.equal((await signIn(h, 'admin2@example.com', 'the admin chose this one')).ok, true);

  // And no credential row exists for anybody the admin did not authenticate as.
  const rows = await h.engine.store.actorCredentials.query([]);
  assert.deepEqual(
    [...rows.map((row) => row.id)].sort(),
    [victim.actorId, adminId].sort(),
    'two credentials, one per account that set one, and no third written on anybody behalf',
  );
});

test('the audit trail records that a credential was written and no part of it', async () => {
  const h = createEngineHarness();
  const { auth } = await h.signUp('audited@example.com', 'Audited');
  await setPassword(h, auth.actorId, PASSWORD);

  const events = await h.engine.store.auditEvents.query([]);
  const entry = events.find((row) => row.action === 'actor.set_password');
  assert.ok(entry, 'setting a password is audited — clause 2');
  const serialised = JSON.stringify(entry);
  assert.equal(serialised.includes(PASSWORD), false, 'the trail holds no password');
  assert.equal(serialised.includes('scrypt'), false, 'and no hash, salt or algorithm');
});

// ── Throttling ───────────────────────────────────────────────────────────
test('consecutive failures earn a widening window, and a success clears it', () => {
  assert.equal(throttleWindowFor(0), 0);
  assert.equal(throttleWindowFor(THROTTLE_AFTER_FAILURES - 1), 0, 'a few mistakes are just mistakes');
  const first = throttleWindowFor(THROTTLE_AFTER_FAILURES);
  const second = throttleWindowFor(THROTTLE_AFTER_FAILURES + 1);
  assert.ok(first > 0);
  assert.equal(second, first * 2, 'and it doubles');
  // Capped, because an unbounded window is indistinguishable from deleting the account.
  assert.equal(throttleWindowFor(THROTTLE_AFTER_FAILURES + 40), throttleWindowFor(THROTTLE_AFTER_FAILURES + 41));

  const created = createCredential({ actorId: 'act_1', password: PASSWORD }, { now: 0 });
  assert.ok(created.ok);
  if (!created.ok) return;
  let credential = created.value;
  for (let attempt = 0; attempt < THROTTLE_AFTER_FAILURES; attempt += 1) {
    credential = recordFailure(credential, 1_000);
  }
  assert.equal(isThrottled(credential, 1_000), true, 'throttled now');
  assert.equal(isThrottled(credential, 1_000 + throttleWindowFor(THROTTLE_AFTER_FAILURES) + 1), false, 'and not later');

  credential = recordSuccess(credential);
  assert.equal(credential.failedAttempts, 0);
  assert.equal(credential.throttleExpiresAt, undefined, 'a success clears the window, not just the count');
  assert.equal(isThrottled(credential, 1_000), false);
});

test('guessing at one account is throttled through the bus, and the refusal is the usual one', async () => {
  const h = createEngineHarness();
  const { auth } = await h.signUp('guessed@example.com', 'Guessed');
  await setPassword(h, auth.actorId, PASSWORD);

  for (let attempt = 0; attempt < THROTTLE_AFTER_FAILURES; attempt += 1) {
    const result = await signIn(h, 'guessed@example.com', `guess number ${attempt}`);
    assert.equal(result.ok, false);
  }
  const credential = await h.engine.store.actorCredentials.get(auth.actorId);
  assert.ok(credential);
  assert.ok((credential?.failedAttempts ?? 0) >= THROTTLE_AFTER_FAILURES, 'the failures are recorded');

  // **Even the correct password is refused while the window holds**, which is the point of a
  // backoff, and the refusal is the same one so the window is not an oracle either.
  const correctButThrottled = await signIn(h, 'guessed@example.com', PASSWORD);
  assert.equal(correctButThrottled.ok, false, 'the window holds against the right password too');
  assert.equal(!correctButThrottled.ok && correctButThrottled.error.code, 'authentication_failed');
});

test('the no-account path spends verification work, so timing is not an oracle', () => {
  /**
   * **The subtle half of "every refusal is identical".** Matching the text is not enough: a wrong
   * password costs an scrypt derivation and an unknown address would cost a table lookup, so the
   * *clock* would answer the question the message refuses to. This asserts the decoy exists and
   * costs something in the same order as a real verification.
   *
   * A wall-clock assertion is ordinarily a bad test. Here the property being certified *is* time,
   * and the bound is deliberately loose — a factor of ten either way — so it tests that the work
   * happens rather than how fast this machine is.
   */
  const created = createCredential({ actorId: 'act_1', password: PASSWORD }, { now: 0 });
  assert.ok(created.ok);
  if (!created.ok) return;

  const realStart = process.hrtime.bigint();
  verifyPassword(created.value, 'a wrong password of similar length');
  const realCost = Number(process.hrtime.bigint() - realStart);

  const decoyStart = process.hrtime.bigint();
  const outcome = spendVerificationWork('a wrong password of similar length');
  const decoyCost = Number(process.hrtime.bigint() - decoyStart);

  assert.equal(outcome, false, 'the decoy always fails');
  assert.ok(decoyCost > realCost / 10, `the decoy costs real work (${decoyCost}ns vs ${realCost}ns)`);
  assert.ok(decoyCost < realCost * 10, 'and not wildly more');
});
