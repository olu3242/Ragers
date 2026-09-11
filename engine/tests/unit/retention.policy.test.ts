import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRetention,
  OBJECT_STORAGE_BLOCKED_REASON,
  RETENTION_CLASSES,
  RETENTION_HOLDS,
  RETENTION_POLICIES,
  retentionAdjustsCorroborationCount,
  retentionDeletesTheFact,
  retentionExpiresAt,
  retentionRemovesProtectedDerivative,
  type RetentionSubject,
} from '../../src/domain/retention.ts';

/**
 * Phase 65, the policy alone.
 *
 * Everything here is a pure function of an artefact, a clock and a set of holds. That is
 * the point of the split: a retention decision is the most destructive thing the system
 * makes, and the part that decides has to be testable without a store, a bucket or a
 * clock that moves.
 */
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const subject = (over: Partial<RetentionSubject> = {}): RetentionSubject => ({
  id: 'media_1',
  retentionClass: 'original_media',
  createdAt: NOW - 10 * DAY,
  ...over,
});

test('an artefact inside its ceiling is within it, not held', () => {
  // The distinction matters for a surface: everything in the archive is inside its
  // ceiling, and calling that `held` would make the whole system look under review.
  const decision = decideRetention(subject(), NOW);
  assert.equal(decision.verdict, 'within_ceiling');
  assert.equal(decision.hold, undefined);
  assert.equal(decision.expiresAt, NOW - 10 * DAY + RETENTION_POLICIES.original_media.ceilingMs);
});

test('an artefact past its ceiling with nothing holding it is expired', () => {
  const decision = decideRetention(subject({ createdAt: NOW - 31 * DAY }), NOW);
  assert.equal(decision.verdict, 'expired');
});

test('the ceiling is exclusive at the instant it falls, so a boundary artefact expires once', () => {
  const created = NOW - RETENTION_POLICIES.original_media.ceilingMs;
  assert.equal(decideRetention(subject({ createdAt: created }), NOW).verdict, 'expired');
  assert.equal(decideRetention(subject({ createdAt: created + 1 }), NOW).verdict, 'within_ceiling');
});

test('an open review holds an expired artefact, and names which review', () => {
  // Removing evidence on schedule in the middle of a review destroys the basis for a
  // decision somebody is about to make, and the decision then gets made without it.
  const decision = decideRetention(subject({ createdAt: NOW - 31 * DAY }), NOW, ['dispute_open']);
  assert.equal(decision.verdict, 'held');
  assert.equal(decision.hold, 'dispute_open');
});

test('a moderation review holds it too, so the hold is not specific to disputes', () => {
  const decision = decideRetention(subject({ createdAt: NOW - 31 * DAY }), NOW, [
    'moderation_review_open',
  ]);
  assert.equal(decision.verdict, 'held');
  assert.equal(decision.hold, 'moderation_review_open');
});

test('an already-removed artefact is not re-decided, whatever else is true of it', () => {
  // Otherwise a second sweep writes a second removal for one removal, and the ledger
  // stops being a record of what happened.
  for (const holds of [[], ['dispute_open'] as const]) {
    const decision = decideRetention(
      subject({ createdAt: NOW - 900 * DAY, removedAt: NOW - DAY }),
      NOW,
      holds,
    );
    assert.equal(decision.verdict, 'already_removed');
  }
});

test('evidence outlives an original, because it was submitted in order to be examined', () => {
  // The one number here chosen to be generous rather than tight. A dispute can be opened
  // long after publication; expiring evidence at thirty days would mean accepting it and
  // destroying it before anybody weighed it.
  assert.ok(
    RETENTION_POLICIES.original_evidence.ceilingMs > RETENTION_POLICIES.original_media.ceilingMs,
    'evidence has the longest ceiling of the three',
  );
  const old = subject({ id: 'ev_1', retentionClass: 'original_evidence', createdAt: NOW - 31 * DAY });
  assert.equal(decideRetention(old, NOW).verdict, 'within_ceiling', 'and 31 days does not expire it');
});

test('a raw transcript gets the same clock as the audio it came from', () => {
  // Not longer: text is searchable, which makes it strictly more dangerous than the
  // recording. Not shorter either — both exist to be re-run if protection failed.
  assert.equal(
    RETENTION_POLICIES.raw_transcript.ceilingMs,
    RETENTION_POLICIES.original_media.ceilingMs,
  );
});

test('every class has a ceiling, a reason, and a ceiling that is not zero', () => {
  assert.equal(RETENTION_CLASSES.length, 3);
  for (const name of RETENTION_CLASSES) {
    const policy = RETENTION_POLICIES[name];
    assert.ok(policy.ceilingMs > 0, `${name} has a real ceiling`);
    assert.ok(policy.reason.length > 40, `${name} says why it has that ceiling`);
  }
});

test('the protected derivative is not a retention class, because it is the public artefact', () => {
  // An experience whose protected audio was removed is indistinguishable from one that
  // never had any, so a reader cannot tell evidence vanished. It goes when the experience
  // goes, which the cascade already handles.
  assert.equal((RETENTION_CLASSES as readonly string[]).includes('protected_media'), false);
  assert.equal((RETENTION_CLASSES as readonly string[]).includes('redacted_transcript'), false);
  assert.equal(retentionRemovesProtectedDerivative(), false);
});

test('retention removes bytes and never facts', () => {
  assert.equal(retentionDeletesTheFact(), false);
  assert.equal(retentionAdjustsCorroborationCount(), undefined);
});

test('the decision always carries a date, so a surface can warn before the ceiling falls', () => {
  for (const name of RETENTION_CLASSES) {
    const decision = decideRetention(subject({ retentionClass: name }), NOW);
    assert.equal(decision.expiresAt, retentionExpiresAt(subject({ retentionClass: name })));
    assert.ok(Number.isFinite(decision.expiresAt));
  }
});

test('the blocked reason says what is and is not done, rather than reporting a success', () => {
  // The honest split: the policy and the ledger are real now; the byte deletion needs a
  // bucket and says so. A sweep reporting `removed` while a file sat in storage would be
  // the most damaging possible place to start claiming something untrue.
  assert.match(OBJECT_STORAGE_BLOCKED_REASON, /No object storage is configured/);
  assert.match(OBJECT_STORAGE_BLOCKED_REASON, /cannot be deleted/);
});

test('only the two named reviews can hold an artefact', () => {
  // A hold is a reason an operator reads, not a boolean, and the set is closed so a
  // future caller cannot invent one that nobody has to justify.
  assert.deepEqual([...RETENTION_HOLDS].sort(), ['dispute_open', 'moderation_review_open']);
});
