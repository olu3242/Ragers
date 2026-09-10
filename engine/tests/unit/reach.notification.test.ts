import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideEmergence,
  emergenceIsVerification,
  EMERGENCE_LABELS,
  EMERGENCE_PERSON_FLOOR,
  FORBIDDEN_EMERGENCE_LABELS,
  reachOf,
  reactionContributesToReach,
  REACH_EXCLUSIONS,
  shareContributesToReach,
} from '../../src/domain/reach.ts';
import {
  decideNotification,
  dedupeKeyFor,
  explainDecision,
  notificationCarriesSubjectBody,
  notificationNamesWatcher,
  NOTIFICATION_STAGES,
  type NotificationContext,
} from '../../src/domain/notification-pipeline.ts';

/**
 * Phases 76, 77 and 79 — the pure parts.
 *
 * The notification pipeline is here rather than only in an integration test because the
 * whole point of naming its stages was to make each one reachable without building the world
 * that leads to it. A stage that can only be exercised end-to-end has one testable path.
 */

// ── Phase 77: reach is people ────────────────────────────────────────────
test('reach counts people, so six accounts from one person is one person', () => {
  const reach = reachOf({
    authorActorId: 'author',
    corroboratorActorIds: ['same_person', 'same_person', 'same_person', 'same_person'],
    shareCount: 0,
    reactionCount: 0,
  });
  assert.equal(reach.people, 2, 'the author and one other');
  assert.equal(reach.selfOrDuplicate, 3, 'and the duplicates are counted as duplicates');
});

test('an author corroborating their own experience adds nothing', () => {
  // Self-amplification, refused by arithmetic rather than by a heuristic: the author is
  // already the person the experience is attributed to.
  const reach = reachOf({
    authorActorId: 'author',
    corroboratorActorIds: ['author'],
    shareCount: 0,
    reactionCount: 0,
  });
  assert.equal(reach.people, 1);
  assert.equal(reach.selfOrDuplicate, 1, 'and it is visibly discarded rather than silently ignored');
});

test('an experience nobody has corroborated has a reach of one, not zero', () => {
  // Zero would say nobody experienced it, which is false — somebody wrote it.
  assert.equal(reachOf({ authorActorId: 'a', corroboratorActorIds: [], shareCount: 0, reactionCount: 0 }).people, 1);
});

test('shares do not increase reach, however many there are', () => {
  const quiet = reachOf({ authorActorId: 'a', corroboratorActorIds: ['b'], shareCount: 0, reactionCount: 0 });
  const viral = reachOf({ authorActorId: 'a', corroboratorActorIds: ['b'], shareCount: 50_000, reactionCount: 900 });
  assert.equal(viral.people, quiet.people, 'travelling far is not happening to more people');
  assert.equal(viral.amplification, 50_000, 'and amplification is reported beside reach, not inside it');
  assert.equal(shareContributesToReach(), false);
  assert.equal(reactionContributesToReach(), false);
});

test('every reach exclusion carries its reason', () => {
  for (const [name, reason] of Object.entries(REACH_EXCLUSIONS)) {
    assert.ok(reason.length > 40, `${name} says why, not just that`);
  }
  for (const expected of ['share', 'reaction', 'reply', 'self']) {
    assert.ok(REACH_EXCLUSIONS[expected] !== undefined, `${expected} is named`);
  }
});

// ── Phase 76: emerging is not verified ───────────────────────────────────
test('a pattern below the person floor is not surfaced at all', () => {
  // Not surfaced with a caveat: a caveat beside a number is read as a number.
  const verdict = decideEmergence({ distinctPeople: 2, distinctExperiences: 3, signalCurrent: true });
  assert.equal(verdict.surfaced, false);
  assert.equal(verdict.surfaced === false && verdict.reason, 'below_person_floor');
});

test('one much-corroborated event is not a pattern', () => {
  const verdict = decideEmergence({ distinctPeople: 40, distinctExperiences: 1, signalCurrent: true });
  assert.equal(verdict.surfaced, false);
  assert.equal(verdict.surfaced === false && verdict.reason, 'below_experience_floor');
});

test('a pattern over a stale signal is not emerging, because it already happened', () => {
  // The refusal that keeps Phase 54's lifecycle from being undone by a discovery read:
  // surfacing an expired pattern as emerging presents history as news.
  const verdict = decideEmergence({ distinctPeople: 30, distinctExperiences: 9, signalCurrent: false });
  assert.equal(verdict.surfaced, false);
  assert.equal(verdict.surfaced === false && verdict.reason, 'signal_not_current');
});

test('a pattern that clears both floors is surfaced, and labelled emerging', () => {
  const verdict = decideEmergence({
    distinctPeople: EMERGENCE_PERSON_FLOOR,
    distinctExperiences: 2,
    signalCurrent: true,
  });
  assert.equal(verdict.surfaced, true);
  assert.equal(verdict.surfaced === true && verdict.label, 'emerging');
});

test('no emergence label could be read as established', () => {
  // The failure mode here is a word. "Confirmed" beside three people's accounts is a claim the
  // data cannot support, and it is the word somebody reaches for when writing a headline.
  for (const forbidden of FORBIDDEN_EMERGENCE_LABELS) {
    assert.equal(EMERGENCE_LABELS.includes(forbidden), false, `${forbidden} is not available`);
  }
  const verdict = decideEmergence({ distinctPeople: 9, distinctExperiences: 4, signalCurrent: true });
  const label = verdict.surfaced === true ? verdict.label : '';
  assert.equal(FORBIDDEN_EMERGENCE_LABELS.includes(label), false);
  assert.equal(emergenceIsVerification(), false);
});

// ── Phase 79: the stages ─────────────────────────────────────────────────
const context = (over: Partial<NotificationContext> = {}): NotificationContext => ({
  recipientActorId: 'recipient',
  originActorId: 'sender',
  blocked: false,
  muted: false,
  preferenceEnabled: true,
  subjectExists: true,
  subjectReadable: true,
  alreadyNotified: false,
  ...over,
});

test('the stages are named, ordered, and end at delivery', () => {
  assert.deepEqual(NOTIFICATION_STAGES, ['eligibility', 'authorization', 'dedupe', 'delivery']);
});

test('a clean context delivers', () => {
  const decision = decideNotification(context());
  assert.equal(decision.deliver, true);
  assert.equal(decision.stage, 'delivery');
});

test('nobody is notified about their own action', () => {
  const decision = decideNotification(context({ originActorId: 'recipient' }));
  assert.equal(decision.deliver, false);
  assert.equal(decision.stage, 'eligibility');
  assert.equal(decision.deliver === false && decision.reason, 'self');
});

test('each eligibility refusal is distinguishable from the others', () => {
  // An operator asked "why did I not get this" needs the specific answer, and a single
  // "suppressed" cannot give one.
  const cases: readonly [Partial<NotificationContext>, string][] = [
    [{ blocked: true }, 'blocked'],
    [{ muted: true }, 'muted'],
    [{ preferenceEnabled: false }, 'preference'],
  ];
  for (const [over, expected] of cases) {
    const decision = decideNotification(context(over));
    assert.equal(decision.stage, 'eligibility');
    assert.equal(decision.deliver === false && decision.reason, expected);
  }
});

test('an authorization refusal is not an eligibility refusal, and says so', () => {
  // **The distinction this phase exists for.** "You asked not to be told" and "you may not be
  // told" are different refusals: one is fixed by a setting and the other is not, and a
  // surface offering a setting for the second would be offering something that does nothing.
  const unreadable = decideNotification(context({ subjectReadable: false }));
  assert.equal(unreadable.stage, 'authorization');
  assert.equal(unreadable.deliver === false && unreadable.reason, 'subject_unreadable');
  assert.equal(
    unreadable.deliver === false && unreadable.recipientCouldEnable,
    false,
    'no setting makes this appear',
  );

  const muted = decideNotification(context({ muted: true }));
  assert.equal(
    muted.deliver === false && muted.recipientCouldEnable,
    true,
    'where a mute is something they control',
  );
});

test('a missing subject and an unreadable one are different facts', () => {
  // Conflating them would either mislead ("you may not see it" when it is simply gone) or
  // leak ("it is gone" when it exists and they may not see it).
  const missing = decideNotification(context({ subjectExists: false }));
  assert.equal(missing.deliver === false && missing.reason, 'subject_missing');
  const unreadable = decideNotification(context({ subjectReadable: false }));
  assert.equal(unreadable.deliver === false && unreadable.reason, 'subject_unreadable');
});

test('authorization runs before dedupe, so a replay about something unreadable says why', () => {
  // Both are true — it was already notified, and it is now unreadable — and the useful answer
  // is the second. "Already notified" would be true and misleading, because the reason it will
  // never be notified again is not that it was.
  const decision = decideNotification(context({ alreadyNotified: true, subjectReadable: false }));
  assert.equal(decision.stage, 'authorization');
});

test('eligibility runs before authorization, which is a cost choice and cannot leak', () => {
  // A refusal at either stage produces no notification, so the order is free — and checking
  // the cheap thing first avoids asking the database whether somebody may read something in
  // order to then discard it because they muted the sender.
  const decision = decideNotification(context({ muted: true, subjectReadable: false }));
  assert.equal(decision.stage, 'eligibility', 'the cheaper check short-circuits');
  assert.equal(decision.deliver, false, 'and either way nothing is delivered');
});

test('a second delivery of the same event is refused at dedupe', () => {
  const decision = decideNotification(context({ alreadyNotified: true }));
  assert.equal(decision.stage, 'dedupe');
  assert.equal(decision.deliver === false && decision.reason, 'already_notified');
});

test('the dedupe key is derived entirely from content, so replay is safe', () => {
  // A key containing a timestamp, a random id or an attempt number would make the second
  // delivery of one event look like a new notification — and at-least-once delivery means a
  // second delivery is normal.
  const parts = {
    kind: 'watched_update',
    subjectId: 'exp_1',
    originActorId: 'system',
    discriminator: 'ResolutionStatusChanged',
  };
  assert.equal(dedupeKeyFor(parts), dedupeKeyFor(parts), 'the same content gives the same key');
  assert.equal(/\d{10,}/.test(dedupeKeyFor(parts)), false, 'and no timestamp is in it');
  assert.notEqual(
    dedupeKeyFor(parts),
    dedupeKeyFor({ ...parts, discriminator: 'DisputeOpened' }),
    'two different events about one thing are two notifications',
  );
});

test('every refusal explains itself, and says whether the recipient could change it', () => {
  assert.match(explainDecision(decideNotification(context())), /^delivered$/);
  assert.match(
    explainDecision(decideNotification(context({ preferenceEnabled: false }))),
    /a setting they control/,
  );
  assert.match(
    explainDecision(decideNotification(context({ subjectReadable: false }))),
    /no setting changes this/,
  );
  assert.match(
    explainDecision(decideNotification(context({ subjectExists: false }))),
    /no longer exists/,
  );
});

test('a notification carries no subject body and names no watcher', () => {
  // Keeping the body out means a bug in authorization is a wrong notification rather than a
  // disclosure — which is the difference that matters when the subject has just been removed.
  assert.equal(notificationCarriesSubjectBody(), false);
  assert.equal(notificationNamesWatcher(), false);
});
