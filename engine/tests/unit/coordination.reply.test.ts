import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseCoordination,
  CO_ARRIVAL_WINDOW_MS,
  COHORT_MINIMUM_ACTORS,
  COHORT_MINIMUM_SHARED,
  coordinationAdjustsCount,
  coordinationSanction,
  MAX_CLAIMS_ANALYSED,
  type ClaimArrival,
} from '../../src/domain/coordination.ts';
import {
  canModerateReply,
  moderateReply,
  replyModerationTouchesParent,
  replyOutcomeOf,
} from '../../src/domain/reply-moderation.ts';
import type { Reply } from '../../src/ports/store.ts';

/**
 * Phases 62 and 63, as pure rules.
 *
 * The false-positive case is the one that matters most in 62, and it is asserted
 * directly: a genuine burst on one account of one thing must not be flagged, because
 * flagging it would train moderators to dismiss the queue and would put the heaviest
 * suspicion on the moments when the product is working.
 */
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const claim = (experienceId: string, actorId: string, at: number): ClaimArrival => ({
  experienceId,
  actorId,
  createdAt: at,
});

// ── P62 coordination ──────────────────────────────────────────────────────
test('a cohort co-arriving across several experiences is one finding', () => {
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2', 'exp_3']) {
    for (const [index, actorId] of ['actor_a', 'actor_b', 'actor_c'].entries()) {
      claims.push(claim(experienceId, actorId, NOW + index * MINUTE));
    }
  }
  const findings = analyseCoordination(claims);
  assert.equal(findings.length, 1, 'one cohort, not one finding per pair');
  assert.deepEqual(findings[0]?.cohort, ['actor_a', 'actor_b', 'actor_c']);
  assert.deepEqual(findings[0]?.experienceIds, ['exp_1', 'exp_2', 'exp_3']);
  assert.equal(findings[0]?.because, 'cohort_co_arrived_across_experiences');
  assert.equal(findings[0]?.sharedCount, 3);
});

test('a genuine burst on one experience is not a finding, however large', () => {
  // The false-positive case, and the reason the rule is co-travelling rather than
  // speed or account age. A local story breaks and forty people recognise it; that is
  // the product working, and flagging it would be worse than useless.
  const claims = Array.from({ length: 40 }, (_, index) =>
    claim('exp_news', `actor_${index}`, NOW + index * 1_000),
  );
  assert.deepEqual(analyseCoordination(claims), [], 'a crowd is not a cohort');
});

test('two accounts are not a cohort, however much they overlap', () => {
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2', 'exp_3', 'exp_4', 'exp_5']) {
    claims.push(claim(experienceId, 'actor_a', NOW));
    claims.push(claim(experienceId, 'actor_b', NOW + MINUTE));
  }
  assert.deepEqual(analyseCoordination(claims), []);
  assert.equal(COHORT_MINIMUM_ACTORS, 3);
});

test('three accounts sharing too few experiences are not a cohort', () => {
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2']) {
    for (const actorId of ['actor_a', 'actor_b', 'actor_c']) {
      claims.push(claim(experienceId, actorId, NOW));
    }
  }
  assert.deepEqual(analyseCoordination(claims), [], 'two shared experiences is a coincidence');
  assert.equal(COHORT_MINIMUM_SHARED, 3);
});

test('claims spread far apart are not co-arrivals', () => {
  // The same three accounts on the same three experiences, but months apart. Three
  // regular readers of the same organization, not a ring.
  const claims: ClaimArrival[] = [];
  for (const [experienceIndex, experienceId] of ['exp_1', 'exp_2', 'exp_3'].entries()) {
    for (const [actorIndex, actorId] of ['actor_a', 'actor_b', 'actor_c'].entries()) {
      claims.push(
        claim(experienceId, actorId, NOW + experienceIndex * 30 * 86_400_000 + actorIndex * (CO_ARRIVAL_WINDOW_MS * 3)),
      );
    }
  }
  assert.deepEqual(analyseCoordination(claims), []);
});

test('a chain of pairs is not a group', () => {
  // a+b share three, b+c share three, but a and c never appeared together. Reporting
  // this as a cohort would name accounts that have nothing to do with each other.
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2', 'exp_3']) {
    claims.push(claim(experienceId, 'actor_a', NOW));
    claims.push(claim(experienceId, 'actor_b', NOW + MINUTE));
  }
  for (const experienceId of ['exp_4', 'exp_5', 'exp_6']) {
    claims.push(claim(experienceId, 'actor_b', NOW));
    claims.push(claim(experienceId, 'actor_c', NOW + MINUTE));
  }
  const findings = analyseCoordination(claims);
  assert.deepEqual(findings, [], 'the whole component must share, not a chain of pairs');
});

test('the analysis is deterministic and order-independent', () => {
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2', 'exp_3']) {
    for (const [index, actorId] of ['actor_c', 'actor_a', 'actor_b'].entries()) {
      claims.push(claim(experienceId, actorId, NOW + index * MINUTE));
    }
  }
  const forward = analyseCoordination(claims);
  const reversed = analyseCoordination([...claims].reverse());
  assert.deepEqual(forward, reversed, 'a sweep run twice reports the same thing');
});

test('empty and oversized inputs report nothing rather than crawling or throwing', () => {
  assert.deepEqual(analyseCoordination([]), []);
  const huge = Array.from({ length: MAX_CLAIMS_ANALYSED + 1 }, (_, index) =>
    claim(`exp_${index % 50}`, `actor_${index % 20}`, NOW + index),
  );
  assert.deepEqual(analyseCoordination(huge), [], 'bounded rather than slow');
});

test('a finding carries no verdict, no weight and no penalty', () => {
  const claims: ClaimArrival[] = [];
  for (const experienceId of ['exp_1', 'exp_2', 'exp_3']) {
    for (const actorId of ['actor_a', 'actor_b', 'actor_c']) claims.push(claim(experienceId, actorId, NOW));
  }
  const finding = analyseCoordination(claims)[0];
  assert.ok(finding);
  assert.deepEqual(Object.keys(finding).sort(), ['because', 'cohort', 'experienceIds', 'sharedCount']);
  for (const forbidden of ['score', 'weight', 'penalty', 'verdict', 'confidence', 'severity']) {
    assert.ok(!(forbidden in finding), `a finding has no ${forbidden}`);
  }
});

test('detection adjusts no count and issues no sanction', () => {
  assert.equal(coordinationAdjustsCount(), undefined);
  assert.equal(coordinationSanction(), undefined);
});

// ── P63 reply moderation ──────────────────────────────────────────────────
const reply = (status: Reply['status']): Reply => ({
  id: 'rep_1',
  experienceId: 'exp_1',
  actorId: 'actor_1',
  creationMode: 'text',
  bodyText: 'a reply',
  visibility: 'public',
  status,
  depth: 0,
  createdAt: NOW,
});

test('a published reply can be removed, and a removed one restored', () => {
  const removed = moderateReply(reply('published'), 'remove');
  assert.equal(removed.ok, true);
  assert.equal(removed.ok && removed.value.reply.status, 'removed');
  assert.equal(removed.ok && removed.value.moved, true);

  const restored = moderateReply(reply('removed'), 'restore');
  assert.equal(restored.ok && restored.value.reply.status, 'published');
});

test("a reply the author deleted is theirs, and a moderator cannot restore it", () => {
  // Restoring somebody's deleted words would be publishing something they withdrew.
  const refused = moderateReply(reply('deleted'), 'restore');
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'reply_transition_invalid');
  assert.equal(canModerateReply('deleted', 'published'), false);
});

test('a warning moves nothing, and is not an error', () => {
  // Warning somebody about a reply is a legitimate action that leaves the reply where
  // it is; refusing it would make the moderator's own queue lie about what they did.
  for (const action of ['warn', 'no_action'] as const) {
    const outcome = moderateReply(reply('published'), action);
    assert.equal(outcome.ok, true, `${action} is allowed`);
    assert.equal(outcome.ok && outcome.value.moved, false);
    assert.equal(outcome.ok && outcome.value.reply.status, 'published');
    assert.equal(replyOutcomeOf(action), undefined);
  }
});

test('removing an already-removed reply is idempotent rather than a conflict', () => {
  const outcome = moderateReply(reply('removed'), 'remove');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.value.moved, false);
});

test('a draft or pending-media reply is not a moderation target', () => {
  for (const status of ['draft', 'pending_media'] as const) {
    assert.equal(moderateReply(reply(status), 'remove').ok, false, `${status} is refused`);
  }
});

test('reply moderation has no path to the parent experience', () => {
  assert.equal(replyModerationTouchesParent(), undefined);
});
