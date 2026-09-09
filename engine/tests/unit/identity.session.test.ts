import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIAS_MAX_LENGTH,
  canTransitionActor,
  createAlias,
  isSessionValid,
  issueSession,
  registerActor,
  retireAlias,
  revokeSession,
  SESSION_TTL_MS,
  type Actor,
} from '../../src/domain/identity.ts';
import { expect } from '../../src/runtime/result.ts';

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  id: 'actor_1',
  email: 'ada@example.com',
  authProvider: 'password',
  displayName: 'Ada',
  defaultVisibility: 'public',
  role: 'member',
  status: 'active',
  createdAt: 1_000,
  lastActiveAt: 1_000,
  ...overrides,
});

test('registration validates the email and display name', () => {
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ email: 'not-an-email' }, 'invalid_email'],
    [{ email: '' }, 'invalid_email'],
    [{ displayName: '   ' }, 'display_name_required'],
    [{ displayName: 'x'.repeat(41) }, 'display_name_too_long'],
    [{ defaultVisibility: 'secret' }, 'invalid_visibility'],
  ];
  for (const [override, code] of cases) {
    const result = registerActor(
      { email: 'ada@example.com', displayName: 'Ada', ...override },
      { id: 'actor_1', now: 1_000 },
    );
    assert.equal(result.ok, false, `${code} must be rejected`);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('a registered actor is a member, never a moderator or admin by default', () => {
  const registered = expect(
    registerActor({ email: 'Ada@Example.COM', displayName: '  Ada  ' }, { id: 'actor_1', now: 1_000 }),
    'register',
  );
  assert.equal(registered.role, 'member', 'privilege is granted explicitly, never on registration');
  assert.equal(registered.email, 'ada@example.com', 'emails are normalised');
  assert.equal(registered.displayName, 'Ada');
  assert.equal(registered.status, 'active');
});

test('alias names are validated and normalised', () => {
  const cases: readonly [string, string][] = [
    ['ab', 'alias_too_short'],
    ['x'.repeat(ALIAS_MAX_LENGTH + 1), 'alias_too_long'],
    ['has spaces', 'alias_invalid_characters'],
    ['Has-Dashes', 'alias_invalid_characters'],
    ['emoji🙌name', 'alias_invalid_characters'],
  ];
  for (const [name, code] of cases) {
    const result = createAlias({ actorId: 'actor_1', aliasName: name }, [], { id: 'alias_1', now: 1_000 });
    assert.equal(result.ok, false, `${name} must be rejected`);
    if (!result.ok) assert.equal(result.error.code, code);
  }

  const valid = expect(
    createAlias({ actorId: 'actor_1', aliasName: '  QuietCommuter  ' }, [], { id: 'alias_1', now: 1_000 }),
    'alias',
  );
  assert.equal(valid.aliasName, 'quietcommuter', 'alias names are normalised to lowercase');
});

test('an active alias name cannot be taken twice', () => {
  const result = createAlias({ actorId: 'actor_2', aliasName: 'QuietCommuter' }, ['quietcommuter'], {
    id: 'alias_2',
    now: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'alias_taken');
});

test('retiring an alias is idempotent', () => {
  const alias = expect(createAlias({ actorId: 'actor_1', aliasName: 'commuter' }, [], { id: 'a', now: 1 }), 'alias');
  const retired = expect(retireAlias(alias), 'retire');
  assert.equal(retired.isActive, false);
  assert.deepEqual(expect(retireAlias(retired), 'again'), retired);
});

test('a session is issued only for an active actor', () => {
  for (const status of ['pending', 'suspended', 'closed'] as const) {
    const result = issueSession(actor({ status }), { id: 'sess_1', now: 1_000 });
    assert.equal(result.ok, false, `a ${status} actor must not receive a session`);
    if (!result.ok) assert.equal(result.error.code, 'actor_not_active');
  }
  assert.ok(issueSession(actor(), { id: 'sess_1', now: 1_000 }).ok);
});

test('a session expires and revocation takes effect immediately', () => {
  const session = expect(issueSession(actor(), { id: 'sess_1', now: 1_000 }), 'session');
  assert.equal(session.expiresAt, 1_000 + SESSION_TTL_MS);
  assert.ok(isSessionValid(session, 1_000 + SESSION_TTL_MS - 1));
  assert.equal(isSessionValid(session, 1_000 + SESSION_TTL_MS), false, 'expiry is exclusive');

  const revoked = revokeSession(session, 2_000);
  assert.equal(isSessionValid(revoked, 2_001), false, 'revocation is immediate');
  assert.deepEqual(revokeSession(revoked, 3_000), revoked, 'revocation is idempotent');
});

test('the actor status machine allows only the documented transitions', () => {
  assert.ok(canTransitionActor('pending', 'active'));
  assert.ok(canTransitionActor('active', 'suspended'));
  assert.ok(canTransitionActor('suspended', 'active'), 'suspension is recoverable');
  assert.equal(canTransitionActor('closed', 'active'), false, 'closed is terminal');
  assert.equal(canTransitionActor('pending', 'suspended'), false);
});
