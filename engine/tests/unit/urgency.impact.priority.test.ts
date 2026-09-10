import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOf } from '../../src/domain/aging.ts';
import { URGENCY_LABELS, urgencyIsNotSeverity, urgencyOf } from '../../src/domain/urgency.ts';
import {
  IMPACT_MINIMUM_EXPERIENCERS,
  describeSpread,
  estimateImpact,
  impactReadsEngagement,
  isEstimated,
  type ImpactInputs,
} from '../../src/domain/impact.ts';
import {
  comparePriority,
  explainOrder,
  prioritise,
  priorityCompositeScore,
  rank,
  type Priority,
} from '../../src/domain/priority.ts';
import type { SeverityBand } from '../../src/domain/severity.ts';

/**
 * Phases 41–43.
 *
 * The assertions that matter are the ones proving the three questions stay apart —
 * severity, urgency and priority disagree constantly, and a queue that collapses any
 * pair is confidently wrong — plus the ones proving an estimate refuses to exist when
 * there is nothing under it.
 */
const DAY = 86_400_000;

const aging = (options: {
  ageDays?: number;
  inStatusDays?: number;
  contactDaysAgo?: number;
  proposedDaysAgo?: number;
  unresolved?: boolean;
}) => {
  const now = 400 * DAY;
  return ageOf({
    events: [],
    currentStatus: options.unresolved === false ? 'resolved' : 'open',
    publishedAt: now - (options.ageDays ?? 1) * DAY,
    ...(options.contactDaysAgo === undefined
      ? {}
      : { lastOrganizationContactAt: now - options.contactDaysAgo * DAY }),
    ...(options.proposedDaysAgo === undefined
      ? {}
      : { proposedResolutionAt: now - options.proposedDaysAgo * DAY }),
    now,
  });
};

const baseUrgency = {
  severityUnassessed: false as boolean,
  safetyAsserted: false,
  openEscalations: 0,
  contested: false,
  acknowledged: true,
  beingWorked: false,
};

// ── Phase 41 — urgency ──────────────────────────────────────────────────
test('urgency is not severity: a minor problem left for months is urgent', () => {
  const stale = urgencyOf({
    ...baseUrgency,
    band: 'minor',
    aging: aging({ ageDays: 120, inStatusDays: 120 }),
  });
  // No severity rule fired — it is minor — and yet it needs attention, because nobody
  // has replied in four months.
  assert.equal(stale.level, 'prompt');
  assert.ok(stale.factors.some((factor) => factor.id === 'unanswered'));
  assert.equal(urgencyIsNotSeverity(), true);
});

test('urgency is not severity in the other direction: a critical problem being worked is not urgent', () => {
  const handled = urgencyOf({
    ...baseUrgency,
    band: 'critical',
    beingWorked: true,
    aging: aging({ ageDays: 3, contactDaysAgo: 1 }),
  });
  // Severity raised it; somebody being on it stepped it back down, and said so.
  assert.equal(handled.level, 'soon');
  assert.ok(handled.factors.some((factor) => factor.direction === 'lowers'));
});

test('an asserted safety concern is immediate and cannot be stepped down', () => {
  const unsafe = urgencyOf({
    ...baseUrgency,
    band: 'minor',
    safetyAsserted: true,
    beingWorked: true,
    aging: aging({ ageDays: 1, contactDaysAgo: 0 }),
  });
  assert.equal(unsafe.level, 'immediate');
  assert.equal(
    unsafe.factors.some((factor) => factor.direction === 'lowers'),
    false,
    'being worked on does not make a safety concern wait',
  );
});

test('urgency is read from what was asserted, not from the band alone', () => {
  // A critical band for a purely financial reason is a different kind of soon from a
  // critical band because somebody said safety was involved.
  const financial = urgencyOf({ ...baseUrgency, band: 'critical', aging: aging({ ageDays: 1, contactDaysAgo: 0 }) });
  const unsafe = urgencyOf({
    ...baseUrgency,
    band: 'critical',
    safetyAsserted: true,
    aging: aging({ ageDays: 1, contactDaysAgo: 0 }),
  });
  assert.notEqual(financial.level, unsafe.level);
});

test('nothing to read is unassessed, and says so rather than reading as checked', () => {
  const nothing = urgencyOf({
    ...baseUrgency,
    severityUnassessed: true,
    aging: aging({ ageDays: 1, contactDaysAgo: 0 }),
  });
  assert.equal(nothing.level, 'routine');
  assert.equal(nothing.unassessed, true);
  assert.deepEqual(nothing.factors, []);
});

test('every urgency factor states itself in words a person reads', () => {
  const urgent = urgencyOf({
    ...baseUrgency,
    band: 'serious',
    openEscalations: 2,
    contested: true,
    aging: aging({ ageDays: 60 }),
  });
  assert.ok(urgent.factors.length >= 3);
  for (const factor of urgent.factors) {
    assert.ok(factor.because.length > 0, `${factor.id} must say why`);
    assert.equal(/^[a-z_]+$/.test(factor.because), false, `${factor.id} must not read as a slug`);
  }
  assert.match(urgent.factors.find((f) => f.id === 'escalated')?.because ?? '', /2 escalations/);
});

test('an open escalation raises urgency without deciding anything', () => {
  const escalated = urgencyOf({
    ...baseUrgency,
    severityUnassessed: true,
    openEscalations: 1,
    aging: aging({ ageDays: 5, contactDaysAgo: 1 }),
  });
  assert.equal(escalated.level, 'prompt');
  assert.equal(escalated.unassessed, false);
});

test('every level has a label a person can read', () => {
  for (const [level, label] of Object.entries(URGENCY_LABELS)) {
    assert.ok(label.length > 0, level);
    assert.equal(/^\d/.test(label), false, 'a level is words, not a number');
  }
});

// ── Phase 42 — impact ───────────────────────────────────────────────────
const impactInputs = (overrides: Partial<ImpactInputs> = {}): ImpactInputs => ({
  distinctExperiencers: 10,
  experiences: 8,
  moneyAsserted: [100, 120, 90],
  minutesAsserted: [60, 90],
  recurrenceAsserted: { yes: 2, answered: 4 },
  severityBands: ['serious', 'minor'],
  runningForDays: 30,
  locations: 3,
  resolutionReports: { resolved: 2, total: 6 },
  ...overrides,
});

test('too few people returns INSUFFICIENT_DATA, never a zero', () => {
  const thin = estimateImpact(impactInputs({ distinctExperiencers: 2 }));
  assert.equal(thin.outcome, 'INSUFFICIENT_DATA');
  // The distinction the whole phase rests on: "we do not know" and "nobody" are
  // opposite statements, and there is no field here a caller could read as zero cost.
  assert.equal('moneyLost' in thin, false);
  assert.equal('timeLostMinutes' in thin, false);
  if (thin.outcome === 'INSUFFICIENT_DATA') {
    assert.equal(thin.shortBy, IMPACT_MINIMUM_EXPERIENCERS - 2);
    assert.ok(thin.explanation.length > 0);
  }
});

test('every figure carries an interval and the number of people who answered', () => {
  const impact = estimateImpact(impactInputs());
  assert.ok(isEstimated(impact));
  if (!isEstimated(impact)) return;
  const money = impact.moneyLost;
  assert.ok(money);
  assert.ok(money.low <= money.midpoint && money.midpoint <= money.high);
  assert.equal(money.reporters, 3);
  // Labelled as reported rather than measured, in the type itself.
  assert.equal(money.reportedByExperiencers, true);
});

test('weaker evidence produces a wider range — the property, not the arithmetic', () => {
  const thin = estimateImpact(impactInputs({ moneyAsserted: [100], distinctExperiencers: 20 }));
  const thick = estimateImpact(
    impactInputs({ moneyAsserted: [100, 100, 100, 100, 100, 100, 100, 100], distinctExperiencers: 20 }),
  );
  assert.ok(isEstimated(thin) && isEstimated(thick));
  if (!isEstimated(thin) || !isEstimated(thick)) return;
  const width = (r: { low: number; high: number }): number => r.high - r.low;
  assert.ok(
    width(thin.moneyLost!) > width(thick.moneyLost!),
    'one answer extrapolated over twenty people must read as less certain than eight',
  );
});

test('a dimension nobody answered produces no figure at all', () => {
  const impact = estimateImpact(impactInputs({ moneyAsserted: [] }));
  assert.ok(isEstimated(impact));
  if (!isEstimated(impact)) return;
  assert.equal(impact.moneyLost, undefined, 'absent, not zero');
  assert.ok(impact.timeLostMinutes, 'the dimensions people did answer are still reported');
});

test('the severity spread is reported as a spread, never averaged', () => {
  const impact = estimateImpact(
    impactInputs({ severityBands: ['critical', 'minor', 'minor', 'minor', 'minor'] }),
  );
  assert.ok(isEstimated(impact));
  if (!isEstimated(impact)) return;
  assert.equal(impact.severitySpread.critical, 1);
  assert.equal(impact.severitySpread.minor, 4);
  // Averaging is how "one critical and four minor" becomes "moderate", which describes
  // nothing that happened to anybody.
  assert.match(describeSpread(impact.severitySpread), /1 critical/);
  assert.match(describeSpread(impact.severitySpread), /4 minor/);
});

test('the resolved share goes through the sample floor like every other rate', () => {
  const few = estimateImpact(impactInputs({ resolutionReports: { resolved: 1, total: 1 } }));
  assert.ok(isEstimated(few));
  if (!isEstimated(few)) return;
  assert.equal(few.resolvedShare.withheld, true, 'one report is not a rate');
  assert.equal('value' in few.resolvedShare, false);
});

test('impact carries the rows it was drawn from, so a reader can check', () => {
  const impact = estimateImpact(impactInputs());
  assert.ok(isEstimated(impact));
  if (!isEstimated(impact)) return;
  assert.equal(impact.basis.distinctExperiencers, 10);
  assert.equal(impact.basis.experiences, 8);
  assert.equal(impact.basis.withAssertedCost, 5);
  assert.equal(impact.basis.locations, 3);
});

test('impact is never drawn from engagement', () => {
  // There is no parameter through which a view, share or reaction could arrive, which
  // is what enforces this rather than a comment asking nicely.
  const keys = Object.keys(impactInputs());
  for (const forbidden of ['views', 'shares', 'reactions', 'engagement', 'clicks']) {
    assert.equal(keys.includes(forbidden), false, `impact must not read ${forbidden}`);
  }
  assert.equal(impactReadsEngagement(), false);
});

test('one person cannot inflate impact by posting repeatedly', () => {
  // Eight accounts, one author. `distinctExperiencers` is what the estimate is drawn
  // over, so the population stays at one and the estimate is refused.
  const solo = estimateImpact(impactInputs({ experiences: 8, distinctExperiencers: 1 }));
  assert.equal(solo.outcome, 'INSUFFICIENT_DATA');
});

// ── Phase 43 — priority ─────────────────────────────────────────────────
const priorityOf = (overrides: Partial<Parameters<typeof prioritise>[0]> = {}): Priority =>
  prioritise({
    subjectId: 'exp_a',
    band: 'minor',
    severityUnassessed: false,
    urgency: 'routine',
    urgencyUnassessed: false,
    impact: estimateImpact(impactInputs()),
    unresolvedDays: 0,
    ...overrides,
  });

test('there is no composite score anywhere in a priority', () => {
  const priority = priorityOf({ band: 'critical', urgency: 'immediate' });
  assert.equal(priorityCompositeScore(), undefined);
  for (const key of Object.keys(priority)) {
    assert.equal(/score|weight|points|total/i.test(key), false, `a priority must not carry ${key}`);
  }
});

test('the band comes with a reason naming a cause, not a number', () => {
  const critical = priorityOf({ band: 'critical', urgency: 'immediate' });
  assert.equal(critical.band, 'CRITICAL');
  assert.match(critical.reason, /needs attention now/);
  assert.ok(critical.dominant.includes('urgency'));
  assert.equal(/\d+\.\d+/.test(critical.reason), false, 'no decimal figure in a reason');
});

test('breadth alone is a stated reason to move something up', () => {
  const broad = priorityOf({
    band: 'minor',
    urgency: 'soon',
    impact: estimateImpact(impactInputs({ distinctExperiencers: 40 })),
  });
  assert.equal(broad.band, 'HIGH');
  assert.deepEqual([...broad.dominant], ['impact']);
  assert.match(broad.reason, /40 people/);
});

test('aging alone is a stated reason too', () => {
  const old = priorityOf({ band: 'minor', urgency: 'routine', unresolvedDays: 90 });
  assert.equal(old.band, 'HIGH');
  assert.deepEqual([...old.dominant], ['aging']);
  assert.match(old.reason, /90 days/);
});

test('nothing assessed is not a priority, and says why', () => {
  const nothing = prioritise({
    subjectId: 'exp_a',
    severityUnassessed: true,
    urgency: 'routine',
    urgencyUnassessed: true,
    impact: estimateImpact(impactInputs({ distinctExperiencers: 1 })),
    unresolvedDays: 0,
  });
  assert.equal(nothing.band, 'LOW');
  assert.equal(nothing.unassessed, true);
  assert.deepEqual([...nothing.dominant], ['none']);
});

test('ordering is deterministic across runs and insertion order', () => {
  const items = [
    priorityOf({ subjectId: 'exp_c', band: 'serious', urgency: 'prompt' }),
    priorityOf({ subjectId: 'exp_a', band: 'critical', urgency: 'immediate' }),
    priorityOf({ subjectId: 'exp_b', band: 'minor', urgency: 'soon' }),
  ];
  const first = rank(items).map((p) => p.subjectId);
  const shuffled = rank([...items].reverse()).map((p) => p.subjectId);
  assert.deepEqual(first, shuffled, 'insertion order cannot change the queue');
  assert.deepEqual(first, ['exp_a', 'exp_c', 'exp_b']);
});

test('two items equal on every dimension are ordered by id, not by chance', () => {
  const left = priorityOf({ subjectId: 'exp_a' });
  const right = priorityOf({ subjectId: 'exp_b' });
  assert.ok(comparePriority(left, right) < 0);
  assert.match(explainOrder(left, right), /ordered by id/);
});

test('every position is answerable: the reason names the dimension that decided it', () => {
  const above = priorityOf({ subjectId: 'a', band: 'critical', urgency: 'immediate' });
  const below = priorityOf({ subjectId: 'b', band: 'minor', urgency: 'soon' });
  assert.match(explainOrder(above, below), /CRITICAL outranks MEDIUM/);

  // Two items in the *same* band, so the comparison falls through to urgency. Both
  // reach CRITICAL — one because it needs attention now, the other because a critical
  // report is broad — which is exactly the pair a band alone cannot separate.
  const sameBand = priorityOf({ subjectId: 'c', band: 'critical', urgency: 'immediate' });
  const alsoSame = priorityOf({
    subjectId: 'd',
    band: 'critical',
    urgency: 'soon',
    impact: estimateImpact(impactInputs({ distinctExperiencers: 40 })),
  });
  assert.equal(sameBand.band, alsoSame.band, 'the same band, so ordering must look further');
  assert.match(explainOrder(sameBand, alsoSame), /immediate is sooner than soon/);
});

test('an unknown impact sorts below a known one of any size', () => {
  const known = priorityOf({
    subjectId: 'a',
    band: 'serious',
    urgency: 'soon',
    impact: estimateImpact(impactInputs({ distinctExperiencers: 5, moneyAsserted: [] })),
  });
  const unknown = priorityOf({
    subjectId: 'b',
    band: 'serious',
    urgency: 'soon',
    impact: estimateImpact(impactInputs({ distinctExperiencers: 1 })),
  });
  // Absence of information must not borrow a position from breadth.
  assert.ok(comparePriority(known, unknown) < 0);
  assert.match(explainOrder(known, unknown), /known here and not there/);
});

test('positions are contiguous and start at one', () => {
  const ranked = rank([
    priorityOf({ subjectId: 'a', urgency: 'immediate' }),
    priorityOf({ subjectId: 'b', urgency: 'soon' }),
    priorityOf({ subjectId: 'c' }),
  ]);
  assert.deepEqual(ranked.map((p) => p.position), [1, 2, 3]);
});

test('the same inputs always produce the same band', () => {
  const inputs = { subjectId: 'x', band: 'serious' as SeverityBand, urgency: 'prompt' as const };
  const runs = Array.from({ length: 5 }, () => priorityOf(inputs).band);
  assert.equal(new Set(runs).size, 1);
});
