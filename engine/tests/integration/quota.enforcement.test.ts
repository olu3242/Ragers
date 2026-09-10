import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { QUOTA_LIMITS, quotaWindowKey } from '../../src/domain/quota.ts';
import { createQuotaGuard } from '../../src/runtime/quota.ts';
import { SERVICE_ACTOR_ID } from '../../src/runtime/authz.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';

/**
 * Phase 61 through the real bus.
 *
 * The unit tests hold the arithmetic. What is here is everything that only exists once
 * the guard is wired: that a burst is actually refused, that the refusal is retryable
 * and costs nothing, that a replay is charged once, and that one class cannot exhaust
 * another — which is the property protecting the one thing that must never be
 * throttled into uselessness.
 */
const create = (h: ReturnType<typeof createEngineHarness>, actor: Parameters<typeof h.engine.bus.dispatch>[0]['actor'], body: string) =>
  h.engine.bus.dispatch<unknown, CreateExperienceResult>({
    name: 'experience.create',
    input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: body, visibility: 'public' },
    actor,
    idempotencyKey: h.nextKey(),
  });

test('a burst past the authoring limit is refused as rate_limited, not as anything else', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('busy@example.com', 'Busy');
  const limit = QUOTA_LIMITS.authoring.limit;

  // Registering already charged the identity class; authoring is its own.
  for (let index = 0; index < limit; index += 1) {
    expect(await create(h, actor, `Account number ${index} of the same problem`), `create ${index}`);
  }

  const refused = await create(h, actor, 'One too many');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.kind, 'rate_limited', 'the kind that had no producer until now');
  assert.equal(refused.ok === false && refused.error.code, 'rate_limited');
  // Retryable, because the caller is meant to come back — the contract the taxonomy
  // has always declared for this kind.
  assert.equal(refused.ok === false && refused.error.retryable, true);
  assert.ok(
    typeof (refused.ok === false ? refused.error.details?.['retryAfterMs'] : undefined) === 'number',
    'and it says when',
  );
});

test('a throttled request writes no row and appends no event', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('atlimit@example.com', 'At Limit');
  const limit = QUOTA_LIMITS.authoring.limit;
  for (let index = 0; index < limit; index += 1) {
    expect(await create(h, actor, `Account number ${index} of the same problem`), `create ${index}`);
  }
  await h.settle();

  const experiencesBefore = await h.engine.store.experiences.count();
  const eventsBefore = (await h.engine.outbox.all()).length;

  const refused = await create(h, actor, 'One too many');
  assert.equal(refused.ok, false);

  assert.equal(await h.engine.store.experiences.count(), experiencesBefore, 'nothing was drafted');
  assert.equal((await h.engine.outbox.all()).length, eventsBefore, 'and nothing was appended');
});

test('a throttle releases the idempotency key, so the caller can come back', async () => {
  // A recorded refusal would poison the key for ever, which for a *retryable* error
  // means the retry the message invites can never succeed.
  const h = createEngineHarness();
  const { actor } = await h.signUp('retry@example.com', 'Retry');
  const limit = QUOTA_LIMITS.authoring.limit;
  for (let index = 0; index < limit; index += 1) {
    expect(await create(h, actor, `Account number ${index} of the same problem`), `create ${index}`);
  }

  const key = 'come-back-later';
  const refused = await h.engine.bus.dispatch({
    name: 'experience.create',
    input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Throttled first', visibility: 'public' },
    actor,
    idempotencyKey: key,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.kind, 'rate_limited');

  // The window rolls over, and the same key works.
  h.clock.advance(QUOTA_LIMITS.authoring.windowMs);
  const accepted = await h.engine.bus.dispatch({
    name: 'experience.create',
    input: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'Throttled first', visibility: 'public' },
    actor,
    idempotencyKey: key,
  });
  assert.equal(accepted.ok, true, 'the key was released rather than recorded');
});

test('a replayed idempotency key is charged once', async () => {
  const h = createEngineHarness();
  const { actor } = await h.signUp('replay@example.com', 'Replay');
  const key = h.nextKey();
  const input = { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'One intent', visibility: 'public' };

  expect(await h.engine.bus.dispatch({ name: 'experience.create', input, actor, idempotencyKey: key }), 'first');
  const before = (await h.engine.store.quotaWindows.get(quotaWindowKey(actor.actorId, 'authoring')))?.count;

  // The same intent again. It replays out of the idempotency store, and the quota check
  // sits *after* the reservation precisely so one intent is charged once.
  expect(await h.engine.bus.dispatch({ name: 'experience.create', input, actor, idempotencyKey: key }), 'replay');
  const after = (await h.engine.store.quotaWindows.get(quotaWindowKey(actor.actorId, 'authoring')))?.count;

  assert.equal(after, before, 'a replay of one intent is not a second request');
});

test('exhausting one class leaves another usable, including reporting harm', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Author');
  const reader = await h.signUp('reader@example.com', 'Reader');
  const created = expect(await create(h, author.actor, 'Something went wrong and nobody fixed it'), 'create');
  await h.settle();

  // Exhaust the reader's corroboration class. A fresh author per experience, because one
  // author would hit their own *authoring* limit first — which is itself the property
  // under test, just from the other side.
  const limit = QUOTA_LIMITS.corroboration.limit;
  for (let index = 0; index < limit; index += 1) {
    const other = await h.signUp(`author${index}@example.com`, `Author ${index}`);
    const written = expect(await create(h, other.actor, `Another account, number ${index}`), 'create');
    await h.settle();
    const claim = await h.engine.bus.dispatch({
      name: 'corroboration.create',
      input: { experienceId: written.experienceId, type: 're_rage' },
      actor: reader.actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(claim.ok, true, `corroboration ${index} of ${limit} is within the limit`);
  }

  const throttled = await h.engine.bus.dispatch({
    name: 'corroboration.create',
    input: { experienceId: created.experienceId, type: 're_rage' },
    actor: reader.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(throttled.ok, false);
  assert.equal(throttled.ok === false && throttled.error.kind, 'rate_limited');

  // And yet: reporting harm still works. This is the property the whole classification
  // exists for — a reader who has been corroborating all afternoon must still be able
  // to report something.
  const reported = await h.engine.bus.dispatch({
    name: 'safety.fileReport',
    input: { targetType: 'experience', targetId: created.experienceId, reasonCode: 'harassment' },
    actor: reader.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(reported.ok, true, 'reporting harm is never throttled');

  // As does tightening your own visibility, and leaving.
  const tightened = await h.engine.bus.dispatch({
    name: 'creator.changeVisibility',
    input: { experienceId: created.experienceId, visibility: 'anonymous' },
    actor: author.actor,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(tightened.ok, true, 'tightening your own visibility is never throttled');
});

test('two actors are counted separately', async () => {
  const h = createEngineHarness();
  const first = await h.signUp('one@example.com', 'One');
  const second = await h.signUp('two@example.com', 'Two');
  const limit = QUOTA_LIMITS.authoring.limit;
  for (let index = 0; index < limit; index += 1) {
    expect(await create(h, first.actor, `Account ${index}`), `create ${index}`);
  }
  assert.equal((await create(h, first.actor, 'over')).ok, false, 'the first is at their limit');
  assert.equal((await create(h, second.actor, 'fine')).ok, true, 'the second is not');
});

test('a simultaneous burst never admits more than the limit', async () => {
  // The property that matters, and the one an earlier version of the guard failed:
  // thirty-two simultaneous requests against a limit of twenty admitted all thirty-two,
  // because each read the same empty row and then took a permissive branch after losing
  // its races.
  //
  // Two intermediate designs let all thirty-two through, for different reasons — see the
  // note in `src/runtime/quota.ts`. Both left the extra requests *uncounted*, which is
  // the part that mattered: a limit with an uncounted path is not a limit. Giving the
  // retry loop `limit + headroom` attempts lets a burst drive the window to full, so the
  // racers beyond the limit meet the ordinary refusal. The bound is exact.
  const h = createEngineHarness();
  const { actor } = await h.signUp('burst@example.com', 'Burst');
  const limit = QUOTA_LIMITS.authoring.limit;

  const results = await Promise.all(
    Array.from({ length: limit + 12 }, (_, index) => create(h, actor, `Concurrent account ${index}`)),
  );
  const accepted = results.filter((result) => result.ok).length;
  assert.equal(accepted, limit, 'exactly the limit got through — no overshoot, and nothing uncounted');
  for (const result of results.filter((candidate) => !candidate.ok)) {
    assert.equal(result.ok === false && result.error.kind, 'rate_limited', 'and every refusal is a throttle');
    assert.equal(result.ok === false && result.error.retryable, true, 'and retryable');
  }
  await h.settle();
  assert.equal(await h.engine.store.experiences.count(), accepted, 'exactly the accepted ones exist');
});

test('a guest is not counted, because a per-actor window cannot express "this caller"', async () => {
  // Guests reach only register and authenticate. Throttling them by actor id would
  // throttle the shared `guest` identity for everybody at once, which is worse than
  // not throttling: the API layer has to do this by address.
  const h = createEngineHarness();
  const guest = { actorId: 'guest', role: 'guest' as const, authenticated: false };
  for (let index = 0; index < QUOTA_LIMITS.identity.limit + 4; index += 1) {
    const result = await h.engine.bus.dispatch({
      name: 'identity.register',
      input: { email: `guest${index}@example.com`, displayName: 'Guest' },
      actor: guest,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(result.ok, true, `registration ${index} is not throttled by actor`);
  }
  assert.equal(await h.engine.store.quotaWindows.count(), 0, 'and nothing was counted against `guest`');
});

test('the engine acting on its own behalf is not charged, and no window is written for it', async () => {
  // A consumer that dispatches a command is the system doing work it chose to do.
  // Throttling that would drop internal work rather than slow a caller down — and there
  // is no account to count against: the service identity has no `actors` row, so a
  // window for it is refused by a foreign key. Before this exclusion the charge *threw*,
  // the bus allowed the request through as an unavailable quota, and the only trace was
  // a database error log.
  const h = createEngineHarness();
  const guard = createQuotaGuard({ windows: h.engine.store.quotaWindows, clock: h.clock });
  const service = { actorId: SERVICE_ACTOR_ID, role: 'moderator' as const, authenticated: true };

  for (let index = 0; index < QUOTA_LIMITS.interaction.limit + 4; index += 1) {
    assert.equal(
      await guard.charge('proposal.create', service),
      undefined,
      `internal dispatch ${index} is not throttled`,
    );
  }
  assert.equal(await h.engine.store.quotaWindows.count(), 0, 'and no window row exists for it');
  assert.equal(
    await h.engine.store.quotaWindows.get(quotaWindowKey(SERVICE_ACTOR_ID, 'interaction')),
    undefined,
    'not under its interaction key either',
  );
});
