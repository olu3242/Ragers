import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../../src/runtime/result.ts';
import {
  assertDimension,
  assertedValues,
  fingerprintOf,
  isSameContent,
  withDimension,
  type EnrichmentValue,
} from '../../src/domain/enrichment.ts';
import { areComparable, classifySeverity, isAtLeastBand } from '../../src/domain/severity.ts';
import { ageOf, daysOf, describeDuration } from '../../src/domain/aging.ts';
import { escalationChangesResolution, escalationsFor } from '../../src/domain/escalation.ts';
import { canTransitionCase, closureIsNotResolution, createCase, transitionCase } from '../../src/domain/case.ts';
import type { ResolutionEvent } from '../../src/domain/resolution.ts';

/**
 * Phases 31–35, at the domain layer.
 *
 * The assertions worth having here are the negative ones — the things that must
 * *not* be derivable. Severity from wording, a band from an absence of information,
 * a resolution from an escalation, an outcome from a closed case.
 */
const DAY = 86_400_000;
const asserted = (input: Parameters<typeof assertDimension>[0]): EnrichmentValue =>
  expect(assertDimension(input, { assertedBy: 'act_1', now: 1_000 }), 'assert');

// ── Phase 31 — enrichment ────────────────────────────────────────────────
test('an asserted dimension is refused when it arrives in the wrong shape', () => {
  // A flag read as an amount would put a 1 into a severity band nobody asserted.
  assert.equal(assertDimension({ dimension: 'money_lost', flag: true }, { assertedBy: 'a', now: 1 }).ok, false);
  assert.equal(assertDimension({ dimension: 'safety_involved', amount: 5 }, { assertedBy: 'a', now: 1 }).ok, false);
  assert.equal(assertDimension({ dimension: 'nonsense', amount: 5 }, { assertedBy: 'a', now: 1 }).ok, false);
});

test('an amount of money without a currency is refused, because it would be compared', () => {
  assert.equal(assertDimension({ dimension: 'money_lost', amount: 40 }, { assertedBy: 'a', now: 1 }).ok, false);
  assert.equal(
    assertDimension({ dimension: 'money_lost', amount: 40, currency: 'gbp' }, { assertedBy: 'a', now: 1 }).ok,
    true,
  );
});

test('an implausible amount is refused rather than allowed to drive a band', () => {
  const typo = assertDimension(
    { dimension: 'money_lost', amount: 99_000_000, currency: 'GBP' },
    { assertedBy: 'a', now: 1 },
  );
  assert.equal(typo.ok, false);
  if (!typo.ok) assert.equal(typo.error.code, 'amount_implausible');
});

test('only what a person asserted reaches a reader — extraction is inert', () => {
  const extracted = expect(
    assertDimension(
      { dimension: 'money_lost', amount: 240, currency: 'GBP' },
      { assertedBy: 'engine', now: 1, provenance: 'extracted' },
    ),
    'extracted',
  );
  const own = asserted({ dimension: 'time_lost_minutes', amount: 90 });
  const values = withDimension([extracted], own);
  assert.deepEqual(
    assertedValues({ values }).map((value) => value.dimension),
    ['time_lost_minutes'],
    'an unconfirmed extraction is not an assertion',
  );
});

test('re-asserting a dimension replaces it rather than accumulating two answers', () => {
  const first = asserted({ dimension: 'time_lost_minutes', amount: 30 });
  const second = asserted({ dimension: 'time_lost_minutes', amount: 120 });
  const values = withDimension(withDimension([], first), second);
  assert.equal(values.length, 1);
  assert.equal(values[0]?.amount, 120);
});

// ── Phase 31 — the ported fingerprint ────────────────────────────────────
test('the fingerprint ignores casing and punctuation but not content', () => {
  const base = { kind: 'rage', entityId: 'ent_1', text: 'They lost my bag, again!' };
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base, text: 'they  lost my BAG again' }));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, text: 'They lost my coat again' }));
});

test('unconfirmed structure contributes nothing, so extraction cannot act as agreement', () => {
  const text = 'Northwind Air never processed the refund';
  const unconfirmed = fingerprintOf({ kind: 'rage', text });
  const confirmed = fingerprintOf({ kind: 'rage', entityId: 'ent_northwind', text });
  // Two accounts naming the same company differ until somebody confirms the entity —
  // which is the same rule matching already holds, reached by a second route.
  assert.notEqual(unconfirmed, confirmed);
  assert.equal(unconfirmed, fingerprintOf({ kind: 'rage', entityId: undefined, text }));
});

test('a Rage and a Rave with identical words are not the same content', () => {
  const text = 'the appointment was moved twice';
  assert.notEqual(fingerprintOf({ kind: 'rage', text }), fingerprintOf({ kind: 'rave', text }));
});

test('an empty fingerprint never matches, so a missing value is not a duplicate', () => {
  assert.equal(isSameContent('', ''), false);
});

// ── Phase 32 — severity ─────────────────────────────────────────────────
test('severity has no way to read text: it takes assertions and a count', () => {
  const furious = classifySeverity({
    asserted: [asserted({ dimension: 'money_lost', amount: 4, currency: 'GBP' })],
    independentExperiencers: 40,
  });
  // Forty people, an outraged account, four pounds. Still minor, because that is
  // what was asserted — and forty reports of an annoyance is not a serious failure.
  assert.equal(furious.band, 'minor');
  assert.equal(furious.independentExperiencers, 40);
});

test('equal volume with different asserted impact never compares equal', () => {
  const inconvenience = classifySeverity({
    asserted: [asserted({ dimension: 'time_lost_minutes', amount: 20 })],
    independentExperiencers: 12,
  });
  const dangerous = classifySeverity({
    asserted: [asserted({ dimension: 'safety_involved', flag: true })],
    independentExperiencers: 12,
  });
  assert.equal(inconvenience.band, 'minor');
  assert.equal(dangerous.band, 'critical');
  assert.equal(areComparable(inconvenience, dangerous), false);
});

test('safety is not averaged away by a small amount of money', () => {
  const both = classifySeverity({
    asserted: [
      asserted({ dimension: 'safety_involved', flag: true }),
      asserted({ dimension: 'money_lost', amount: 3, currency: 'GBP' }),
    ],
    independentExperiencers: 1,
  });
  assert.equal(both.band, 'critical', 'the highest dimension wins; nothing is weighted down');
});

test('nothing asserted is unassessed, not minor', () => {
  const nothing = classifySeverity({ asserted: [], independentExperiencers: 5 });
  assert.equal(nothing.unassessed, true);
  assert.equal(nothing.confidence, 0);
  assert.deepEqual(nothing.basis, []);
});

test('recurrence raises a band by one step and never sets one on its own', () => {
  const alone = classifySeverity({
    asserted: [asserted({ dimension: 'recurrence', flag: true })],
    independentExperiencers: 1,
  });
  assert.equal(alone.band, 'minor', 'that it keeps happening says nothing about how bad it is');

  const withMoney = classifySeverity({
    asserted: [
      asserted({ dimension: 'money_lost', amount: 80, currency: 'GBP' }),
      asserted({ dimension: 'recurrence', flag: true }),
    ],
    independentExperiencers: 1,
  });
  assert.equal(withMoney.band, 'serious', 'significant, stepped once for recurrence');
});

test('confidence reports how much was answered, and is not a probability', () => {
  const one = classifySeverity({
    asserted: [asserted({ dimension: 'time_lost_minutes', amount: 600 })],
    independentExperiencers: 0,
  });
  const three = classifySeverity({
    asserted: [
      asserted({ dimension: 'time_lost_minutes', amount: 600 }),
      asserted({ dimension: 'money_lost', amount: 600, currency: 'GBP' }),
      asserted({ dimension: 'service_interrupted', flag: true }),
    ],
    independentExperiencers: 0,
  });
  assert.ok(three.confidence > one.confidence);
  assert.equal(one.band, three.band, 'the same band, read with different confidence');
});

test('band ordering is total, so a floor comparison is meaningful', () => {
  assert.equal(isAtLeastBand('critical', 'serious'), true);
  assert.equal(isAtLeastBand('significant', 'serious'), false);
});

// ── Phase 33 — aging ────────────────────────────────────────────────────
const event = (toStatus: ResolutionEvent['toStatus'], createdAt: number): ResolutionEvent => ({
  id: `re_${createdAt}`,
  experienceId: 'exp_1',
  toStatus,
  source: 'organization',
  correlationId: 'corr',
  createdAt,
});

test('aging is derived from the event log, so it cannot go stale', () => {
  const now = 100 * DAY;
  const aging = ageOf({
    events: [event('acknowledged', 90 * DAY), event('under_review', 95 * DAY)],
    currentStatus: 'under_review',
    publishedAt: 80 * DAY,
    now,
  });
  assert.equal(daysOf(aging.ageMs), 20);
  assert.equal(daysOf(aging.inCurrentStatusMs), 5);
  assert.equal(aging.unresolved, true);
});

test('silence is aged as silence and is never turned into an answer', () => {
  const quiet = ageOf({
    events: [],
    currentStatus: 'open',
    publishedAt: 0,
    now: 60 * DAY,
  });
  // No organization contact at all: the field is absent rather than zero, because
  // zero would read as "answered instantly".
  assert.equal(quiet.sinceOrganizationContactMs, undefined);
  assert.equal(quiet.unresolved, true);
});

test('a settled outcome stops being unresolved without erasing its age', () => {
  const settled = ageOf({
    events: [event('resolved', 10 * DAY)],
    currentStatus: 'resolved',
    publishedAt: 0,
    now: 12 * DAY,
  });
  assert.equal(settled.unresolved, false);
  assert.equal(daysOf(settled.ageMs), 12);
});

test('durations read as words a person can act on, not false precision', () => {
  assert.equal(describeDuration(30 * 60_000), 'under an hour');
  assert.equal(describeDuration(3 * 3_600_000), '3 hours');
  assert.equal(describeDuration(1 * DAY), '1 day');
  assert.equal(describeDuration(21 * DAY), '3 weeks');
  assert.equal(describeDuration(90 * DAY), '3 months');
});

// ── Phase 34 — escalation ───────────────────────────────────────────────
const baseEscalation = {
  experienceId: 'exp_1',
  band: 'serious' as const,
  unassessedSeverity: false,
  independentExperiencers: 1,
  hasLiveDispute: false,
  acknowledged: true,
};

test('an unassessed severity satisfies no severity rule', () => {
  const rules = escalationsFor({
    ...baseEscalation,
    band: 'minor',
    unassessedSeverity: true,
    aging: ageOf({ events: [], currentStatus: 'open', publishedAt: 0, now: 60 * DAY }),
  });
  // The default band is `minor`; escalating on it would be escalating on the absence
  // of information rather than on anything anybody said.
  assert.deepEqual(rules.map((rule) => rule.ruleId), []);
});

test('a serious, stale experience escalates and says why in the operator’s words', () => {
  const rules = escalationsFor({
    ...baseEscalation,
    aging: ageOf({ events: [], currentStatus: 'open', publishedAt: 0, now: 30 * DAY }),
  });
  const stale = rules.find((rule) => rule.ruleId === 'serious_and_stale');
  assert.ok(stale, 'the rule fires');
  assert.match(stale.because, /serious and unresolved for 30 days/);
});

test('the escalation key is deterministic, so the same condition never queues twice', () => {
  const input = {
    ...baseEscalation,
    aging: ageOf({ events: [], currentStatus: 'open', publishedAt: 0, now: 30 * DAY }),
  };
  const first = escalationsFor(input);
  const second = escalationsFor(input);
  assert.deepEqual(
    first.map((rule) => rule.escalationKey),
    second.map((rule) => rule.escalationKey),
  );
  assert.equal(first[0]?.escalationKey, 'exp_1:serious_and_stale');
});

test('every reason that fires is reported, not just the first', () => {
  const rules = escalationsFor({
    ...baseEscalation,
    band: 'critical',
    acknowledged: false,
    independentExperiencers: 25,
    aging: ageOf({ events: [], currentStatus: 'open', publishedAt: 0, now: 40 * DAY }),
  });
  const ids = rules.map((rule) => rule.ruleId).sort();
  assert.deepEqual(ids, ['critical_unacknowledged', 'many_experiencers_no_response', 'serious_and_stale']);
});

test('an unconfirmed proposed fix escalates without deciding it either way', () => {
  const rules = escalationsFor({
    ...baseEscalation,
    band: 'minor',
    unassessedSeverity: true,
    aging: ageOf({
      events: [],
      currentStatus: 'acknowledged',
      publishedAt: 0,
      proposedResolutionAt: 5 * DAY,
      now: 40 * DAY,
    }),
  });
  assert.deepEqual(rules.map((rule) => rule.ruleId), ['proposed_fix_unconfirmed']);
});

test('escalation proposes no resolution status — the rule, as code', () => {
  assert.equal(escalationChangesResolution(), false);
});

// ── Phase 35 — organization cases ───────────────────────────────────────
test('closing a case requires an account of what was done', () => {
  const opened = expect(
    createCase({ organizationId: 'org_1', experienceId: 'exp_1' }, { id: 'case_1', correlationId: 'c', now: 1 }),
    'open',
  );
  const bare = transitionCase(opened, { to: 'closed' }, 2);
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.equal(bare.error.code, 'closure_note_required');

  const closed = expect(transitionCase(opened, { to: 'closed', note: 'Refunded in full' }, 2), 'close');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closureNote, 'Refunded in full');
});

test('a closed case has no mapping to a resolution status', () => {
  // The one function that could plausibly have provided such a mapping refuses to.
  assert.equal(closureIsNotResolution(), undefined);
});

test('a closed case reopens, because the experience can be reopened at any time', () => {
  assert.equal(canTransitionCase('closed', 'in_progress'), true);
  assert.equal(canTransitionCase('new', 'awaiting_customer'), false);
});

test('transitioning to the state a case is already in is idempotent, not an error', () => {
  const opened = expect(
    createCase({ organizationId: 'org_1', experienceId: 'exp_1' }, { id: 'case_1', correlationId: 'c', now: 1 }),
    'open',
  );
  const same = expect(transitionCase(opened, { to: 'new' }, 9), 'same');
  assert.equal(same.state, 'new');
  assert.equal(same.updatedAt, 1, 'nothing changed, so nothing was touched');
});

test('reopening a closed case drops its closure fields rather than keeping a stale note', () => {
  const opened = expect(
    createCase({ organizationId: 'org_1', experienceId: 'exp_1' }, { id: 'case_1', correlationId: 'c', now: 1 }),
    'open',
  );
  const closed = expect(transitionCase(opened, { to: 'closed', note: 'Refunded' }, 2), 'close');
  const reopened = expect(transitionCase(closed, { to: 'in_progress' }, 3), 'reopen');
  assert.equal(reopened.closedAt, undefined);
  assert.equal(reopened.closureNote, undefined);
  assert.equal('closedAt' in reopened, false, 'the key is absent, not undefined');
});
