import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHarness, guest, member, moderator } from '../support/runtime-harness.ts';
import { ok } from '../../src/runtime/result.ts';

test('authorization runs before the domain transition, so a denied command never executes', async () => {
  const h = createRuntimeHarness();
  let handlerRan = false;
  h.bus.register({
    name: 'test.privileged',
    action: 'role.grant', // admin-only
    resolveResource: async () => ok({ type: 'role_assignment' as const }),
    handle: async () => {
      handlerRan = true;
      return ok({ value: 'granted' });
    },
  });

  const result = await h.bus.dispatch({
    name: 'test.privileged',
    input: {},
    actor: member(),
    idempotencyKey: 'k',
  });

  assert.equal(result.ok, false);
  assert.equal(handlerRan, false, 'the handler must never run when policy denies');
  if (!result.ok) assert.equal(result.error.kind, 'unauthorized');
  assert.equal((await h.outbox.all()).length, 0, 'a denied command emits no events');
});

test('a denied command is recorded so a replay is stable', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.denied',
    action: 'audit.read',
    resolveResource: async () => ok({ type: 'audit' as const }),
    handle: async () => ok({ value: 'audit' }),
  });

  const first = await h.bus.dispatch({ name: 'test.denied', input: {}, actor: member(), idempotencyKey: 'k' });
  const replay = await h.bus.dispatch({ name: 'test.denied', input: {}, actor: member(), idempotencyKey: 'k' });
  assert.deepEqual(first, replay);
});

test('an unregistered command is refused rather than silently ignored', async () => {
  const h = createRuntimeHarness();
  const result = await h.bus.dispatch({ name: 'nope', input: {}, actor: member(), idempotencyKey: 'k' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'command_not_registered');
});

test('registering the same command twice is a programming error', () => {
  const h = createRuntimeHarness();
  const handler = {
    name: 'test.dup',
    action: 'experience.create' as const,
    resolveResource: async () => ok({ type: 'experience' as const }),
    handle: async () => ok({ value: 1 }),
  };
  h.bus.register(handler);
  assert.throws(() => h.bus.register(handler), /Duplicate command handler/);
});

test('resource resolution failure short-circuits before authorization', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.missing',
    action: 'experience.read',
    resolveResource: async () => ({
      ok: false as const,
      error: { kind: 'not_found' as const, code: 'no_experience', message: 'gone', retryable: false },
    }),
    handle: async () => ok({ value: 'never' }),
  });

  const result = await h.bus.dispatch({ name: 'test.missing', input: {}, actor: guest(), idempotencyKey: 'k' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'not_found');
});

test('a moderator-gated command succeeds for a moderator and fails for a member', async () => {
  const h = createRuntimeHarness();
  h.bus.register({
    name: 'test.queue',
    action: 'moderation.read_queue',
    resolveResource: async () => ok({ type: 'queue_item' as const }),
    handle: async () => ok({ value: 'queue' }),
  });

  const asMember = await h.bus.dispatch({
    name: 'test.queue',
    input: {},
    actor: member(),
    idempotencyKey: 'k1',
  });
  const asModerator = await h.bus.dispatch({
    name: 'test.queue',
    input: {},
    actor: moderator(),
    idempotencyKey: 'k2',
  });

  assert.equal(asMember.ok, false);
  assert.deepEqual(asModerator, ok('queue'));
});
