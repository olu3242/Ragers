import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness, type EngineHarness } from '../support/engine-harness.ts';
import { expect } from '../../src/runtime/result.ts';
import { eq } from '../../src/ports/store.ts';
import { corroborationsFor } from '../../src/engines/corroboration.engine.ts';
import type { ActorContext } from '../../src/runtime/authz.ts';
import type { ExperienceKind } from '../../src/domain/types.ts';
import type { CreateExperienceResult } from '../../src/engines/experience.engine.ts';
import type { CorroborateResult } from '../../src/engines/corroboration.engine.ts';
import type { CorroborationRow } from '../../src/ports/store.ts';

/**
 * The corroboration contract, end to end through the command bus.
 *
 * The property that matters throughout: a corroboration count is a count of
 * *people claiming the experience*, and nothing else can inflate it.
 */
const publish = async (
  h: EngineHarness,
  actor: ActorContext,
  kind: ExperienceKind = 'rage',
  bodyText = 'The refund never arrived.',
): Promise<string> => {
  const created = expect(
    await h.engine.bus.dispatch<unknown, CreateExperienceResult>({
      name: 'experience.create',
      input: { kind, creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
      actor,
      idempotencyKey: h.nextKey(),
    }),
    'create',
  );
  await h.settle();
  return created.experienceId;
};

const corroborate = (h: EngineHarness, actor: ActorContext, input: Record<string, unknown>) =>
  h.engine.bus.dispatch<unknown, CorroborateResult>({
    name: 'corroboration.create',
    input,
    actor,
    idempotencyKey: h.nextKey(),
  });

test('a Re-Rage corroborates a Rage rather than cloning it', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com', 'Author');
  const other = await h.signUp('other@example.com', 'Other');
  const experienceId = await publish(h, author.actor);

  const experiencesBefore = await h.engine.store.experiences.count();

  const result = expect(
    await corroborate(h, other.actor, { experienceId, type: 're_rage' }),
    'corroborate',
  );
  assert.equal(result.type, 're_rage');
  assert.equal(result.relationship, 'same_experience');
  assert.equal(result.corroborationCount, 1);

  // No second experience was created — this is the whole point.
  assert.equal(
    await h.engine.store.experiences.count(),
    experiencesBefore,
    'a Re-Rage must not clone the experience',
  );

  const rows = await corroborationsFor(h.engine, experienceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.corroboratorId, other.auth.actorId);
  assert.equal(rows[0]?.experienceId, experienceId, 'it points at the original');
});

test('a Re-Rave corroborates a Rave equivalently', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor, 'rave', 'The refund arrived the same day.');

  const result = expect(
    await corroborate(h, other.actor, { experienceId, type: 're_rave' }),
    'corroborate',
  );
  assert.equal(result.type, 're_rave');
  assert.equal(result.corroborationCount, 1);
});

test('a Rage refuses a Re-Rave, and a Rave refuses a Re-Rage', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const rageId = await publish(h, author.actor, 'rage');
  const raveId = await publish(h, author.actor, 'rave', 'Something went well.');

  const wrongOnRage = await corroborate(h, other.actor, { experienceId: rageId, type: 're_rave' });
  assert.equal(wrongOnRage.ok, false);
  if (!wrongOnRage.ok) assert.equal(wrongOnRage.error.code, 'corroboration_kind_mismatch');

  const wrongOnRave = await corroborate(h, other.actor, { experienceId: raveId, type: 're_rage' });
  assert.equal(wrongOnRave.ok, false);
  if (!wrongOnRave.ok) assert.equal(wrongOnRave.error.code, 'corroboration_kind_mismatch');

  assert.equal(await h.engine.store.corroborations.count(), 0, 'neither mismatch was stored');
});

test('a person cannot corroborate the same experience twice', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  expect(await corroborate(h, other.actor, { experienceId, type: 're_rage' }), 'first');
  const second = await corroborate(h, other.actor, { experienceId, type: 're_rage' });

  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, 'already_corroborated');
  assert.equal(
    await h.engine.store.corroborations.countWhere([eq<CorroborationRow>('experienceId', experienceId)]),
    1,
    'one person, one claim',
  );
});

test('concurrent corroborations from one person produce exactly one claim', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => corroborate(h, other.actor, { experienceId, type: 're_rage' })),
  );

  const succeeded = results.filter((result) => result.ok);
  assert.equal(succeeded.length, 1, 'exactly one of eight concurrent attempts may win');
  assert.equal(
    await h.engine.store.corroborations.countWhere([eq<CorroborationRow>('experienceId', experienceId)]),
    1,
    'nobody can manufacture corroborations by racing',
  );
});

test('an author cannot corroborate their own experience', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor);

  const result = await corroborate(h, author.actor, { experienceId, type: 're_rage' });
  assert.equal(result.ok, false, 'posting it was already the claim');
  if (!result.ok) assert.equal(result.error.code, 'policy_owner_forbidden');
});

test('corroborating unpublished or removed content is refused', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const moderator = await h.promote((await h.signUp('mod@example.com')).auth.actorId, 'moderator');
  const experienceId = await publish(h, author.actor);

  expect(
    await h.engine.bus.dispatch({
      name: 'safety.applyModerationAction',
      input: { targetType: 'experience', targetId: experienceId, action: 'remove', reason: 'harassment' },
      actor: moderator,
      idempotencyKey: h.nextKey(),
    }),
    'remove',
  );

  const result = await corroborate(h, other.actor, { experienceId, type: 're_rage' });
  assert.equal(result.ok, false, 'removed content cannot gather claims');
});

test('optional context, place and voice attach to a corroboration', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  const result = expect(
    await corroborate(h, other.actor, {
      experienceId,
      type: 're_rage',
      narrative: 'Same thing, three weeks of waiting.',
      relationship: 'similar_experience',
    }),
    'with context',
  );
  assert.equal(result.relationship, 'similar_experience');

  const row = (await corroborationsFor(h.engine, experienceId))[0];
  assert.equal(row?.narrative, 'Same thing, three weeks of waiting.');
});

test('a corroboration can be anonymous without losing the claim', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com', 'Real Name');
  const experienceId = await publish(h, author.actor);

  expect(
    await corroborate(h, other.actor, { experienceId, type: 're_rage', visibility: 'anonymous' }),
    'anonymous claim',
  );

  const row = (await corroborationsFor(h.engine, experienceId))[0];
  assert.equal(row?.visibility, 'anonymous');
  // The row retains attribution internally, which is what makes the count real,
  // while the projection must never expose it.
  assert.equal(row?.corroboratorId, other.auth.actorId);

  await h.settle();
  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.reRageCount, 1, 'an anonymous claim still counts');
});

// ── Share is a different thing ───────────────────────────────────────────
test('a share never increments the corroboration count', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  // Share many times, from several people.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(
      await h.engine.bus.dispatch<unknown, { shareCount: number }>({
        name: 'share.create',
        input: { experienceId, destination: 'copy_link' },
        actor: other.actor,
        idempotencyKey: h.nextKey(),
      }),
      'share',
    );
  }
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.shareCount, 5, 'shares are counted');
  assert.equal(counters?.reRageCount, 0, 'and never as claims');
  assert.equal(counters?.corroboratorCount, 0);
  assert.equal(await h.engine.store.corroborations.count(), 0, 'no corroboration row was created');
});

test('a guest can share but cannot corroborate', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const experienceId = await publish(h, author.actor);
  const guest = { actorId: 'guest', role: 'guest' as const, authenticated: false };

  const shared = await h.engine.bus.dispatch({
    name: 'share.create',
    input: { experienceId },
    actor: guest,
    idempotencyKey: h.nextKey(),
  });
  assert.equal(shared.ok, true, 'amplification does not require an account');

  const claimed = await corroborate(h, guest, { experienceId, type: 're_rage' });
  assert.equal(claimed.ok, false, 'a claim requires an accountable person');
});

// ── Counts recompute rather than increment ───────────────────────────────
test('retracting a claim decrements the count correctly', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const first = await h.signUp('first@example.com');
  const second = await h.signUp('second@example.com');
  const experienceId = await publish(h, author.actor);

  const one = expect(await corroborate(h, first.actor, { experienceId, type: 're_rage' }), 'first');
  expect(await corroborate(h, second.actor, { experienceId, type: 're_rage' }), 'second');
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.reRageCount, 2);

  const retracted = expect(
    await h.engine.bus.dispatch<unknown, { corroborationCount: number }>({
      name: 'corroboration.retract',
      input: { corroborationId: one.corroborationId },
      actor: first.actor,
      idempotencyKey: h.nextKey(),
    }),
    'retract',
  );
  assert.equal(retracted.corroborationCount, 1);
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.reRageCount, 1, 'the count follows the rows');
  assert.equal(counters?.corroboratorCount, 1);

  // The record survives, so the history stays auditable.
  const row = await h.engine.store.corroborations.get(one.corroborationId);
  assert.equal(row?.status, 'retracted');
  assert.ok(row?.retractedAt);
});

test('only the claimant may retract their own claim', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const claimant = await h.signUp('claimant@example.com');
  const stranger = await h.signUp('stranger@example.com');
  const experienceId = await publish(h, author.actor);

  const claim = expect(await corroborate(h, claimant.actor, { experienceId, type: 're_rage' }), 'claim');

  for (const actor of [stranger.actor, author.actor]) {
    const attempt = await h.engine.bus.dispatch({
      name: 'corroboration.retract',
      input: { corroborationId: claim.corroborationId },
      actor,
      idempotencyKey: h.nextKey(),
    });
    assert.equal(attempt.ok, false, 'nobody else may withdraw your claim');
    if (!attempt.ok) assert.equal(attempt.error.code, 'policy_not_owner');
  }
});

test('a person who retracted can claim again, and the count stays truthful', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  const claim = expect(await corroborate(h, other.actor, { experienceId, type: 're_rage' }), 'claim');
  expect(
    await h.engine.bus.dispatch({
      name: 'corroboration.retract',
      input: { corroborationId: claim.corroborationId },
      actor: other.actor,
      idempotencyKey: h.nextKey(),
    }),
    'retract',
  );
  await h.settle();
  assert.equal((await h.engine.store.counters.get(experienceId))?.reRageCount, 0);

  const again = expect(await corroborate(h, other.actor, { experienceId, type: 're_rage' }), 'reclaim');
  assert.equal(again.corroborationCount, 1);
  await h.settle();

  assert.equal((await h.engine.store.counters.get(experienceId))?.reRageCount, 1);
  assert.equal(
    await h.engine.store.corroborations.countWhere([eq<CorroborationRow>('experienceId', experienceId)]),
    1,
    'reclaiming reuses the row rather than creating a second one',
  );
});

test('counts converge under duplicated and repeated event delivery', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const people = await Promise.all([
    h.signUp('a@example.com'),
    h.signUp('b@example.com'),
    h.signUp('c@example.com'),
  ]);
  const experienceId = await publish(h, author.actor);

  for (const person of people) {
    expect(await corroborate(h, person.actor, { experienceId, type: 're_rage' }), 'claim');
  }

  // Drain repeatedly: recomputed counters must not drift.
  await h.settle();
  await h.settle();
  await h.settle();

  const counters = await h.engine.store.counters.get(experienceId);
  assert.equal(counters?.reRageCount, 3);
  assert.equal(counters?.corroboratorCount, 3);
});

test('the corroboration event names the claim, not a repost', async () => {
  const h = createEngineHarness();
  const author = await h.signUp('author@example.com');
  const other = await h.signUp('other@example.com');
  const experienceId = await publish(h, author.actor);

  expect(await corroborate(h, other.actor, { experienceId, type: 're_rage' }), 'claim');

  const events = (await h.engine.outbox.all()).map((row) => row.eventName);
  assert.ok(events.includes('ExperienceReRaged'), 'the event says what happened');
  assert.equal(events.some((name) => /Repost|Retweet|Liked/.test(name)), false);
});
