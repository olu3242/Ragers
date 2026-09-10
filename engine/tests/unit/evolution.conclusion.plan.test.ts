import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalSeries,
  cumulativeSeries,
  directionOf,
  evolutionCompositeScore,
  EVOLUTION_COMPONENTS,
  EXCLUDED_FROM_EVOLUTION,
} from '../../src/domain/evolution.ts';
import {
  CONCLUSION_KINDS,
  conclusionKeyOf,
  drawConclusion,
  enactConclusion,
  MINIMUM_EXPERIENCES,
  MINIMUM_PEOPLE,
  type Conclusion,
} from '../../src/domain/conclusion.ts';
import {
  draftPlan,
  forbiddenCommandsIn,
  MAX_PLAN_STEPS,
  planCanMutateDirectly,
  planStatusFrom,
  schedulePlan,
  type PlanStep,
  type StepOutcome,
} from '../../src/domain/plan.ts';
import { floorFor } from '../../src/domain/sampling.ts';
import { expect } from '../../src/runtime/result.ts';

/**
 * Phases 56–59, as pure rules.
 *
 * The three that matter most are here rather than in the integration file, because
 * they are properties of the rules themselves and a test that needs a whole seeded
 * world to state them is a test that will eventually be weakened to keep passing:
 * reputation replays, a conclusion with no basis is refused, and a plan cannot name a
 * forbidden command.
 */
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const boundaries = [NOW - 60 * DAY, NOW - 30 * DAY, NOW];

// ── P56 reputation evolution ──────────────────────────────────────────────
test('a component series is cumulative as of each boundary', () => {
  const series = cumulativeSeries('experiences_published', [NOW - 70 * DAY, NOW - 40 * DAY, NOW - 2 * DAY], boundaries);
  assert.deepEqual(series.points.map((point) => point.value), [1, 2, 3]);
  assert.equal(series.direction, 'rising');
});

test('reputation replays: the same facts in any order give the same series', () => {
  // The failure test the phase names. Each point counts the whole set rather than
  // folding forward, so a duplicated or late delivery cannot inflate a series — which
  // is what makes evolution derived rather than accumulated.
  const facts = [NOW - 70 * DAY, NOW - 40 * DAY, NOW - 2 * DAY, NOW - 55 * DAY];
  const forward = cumulativeSeries('corroborations_given', facts, boundaries);
  const reversed = cumulativeSeries('corroborations_given', [...facts].reverse(), boundaries);
  const shuffled = cumulativeSeries('corroborations_given', [facts[2]!, facts[0]!, facts[3]!, facts[1]!], boundaries);

  assert.deepEqual(forward.points, reversed.points);
  assert.deepEqual(forward.points, shuffled.points);
  assert.equal(forward.direction, reversed.direction);
});

test('boundaries given out of order still produce a series in order', () => {
  const series = cumulativeSeries('experiences_published', [NOW - 70 * DAY], [NOW, NOW - 60 * DAY, NOW - 30 * DAY]);
  assert.deepEqual(series.points.map((point) => point.asOf), [NOW - 60 * DAY, NOW - 30 * DAY, NOW]);
});

test('a single point has no direction', () => {
  assert.equal(directionOf([{ value: 5 }]), 'steady');
  assert.equal(directionOf([]), 'steady');
});

test('an approval rate is withheld until enough people have voted', () => {
  const floor = floorFor('approval_rate');
  const votes = Array.from({ length: floor }, (_, index) => ({
    at: NOW - (floor - index) * DAY,
    inFavour: index % 2 === 0,
  }));
  const series = approvalSeries(votes, boundaries);

  const earliest = series.points[0];
  assert.ok(earliest);
  assert.equal(earliest.value.withheld, true, 'nothing had been voted on by then');

  const latest = series.points.at(-1);
  assert.equal(latest?.value.withheld, false, 'and by now the floor is cleared');
});

test('an approval direction needs two reported points, not one', () => {
  const floor = floorFor('approval_rate');
  // Every vote lands in the last period, so only the final point clears the floor.
  const votes = Array.from({ length: floor }, () => ({ at: NOW - 1 * DAY, inFavour: true }));
  const series = approvalSeries(votes, boundaries);
  assert.equal(series.direction, undefined, 'comparing a number against an absent one is not a direction');
});

test('there is no single reputation number, and no engagement input', () => {
  assert.equal(evolutionCompositeScore(), undefined);
  for (const excluded of EXCLUDED_FROM_EVOLUTION) {
    assert.ok(!EVOLUTION_COMPONENTS.includes(excluded as never), `${excluded} is not a component`);
  }
});

// ── P57 cross-experience conclusions ──────────────────────────────────────
const conclusionInput = (overrides: Record<string, unknown> = {}) => ({
  kind: 'recurring_failure',
  subjectId: 'clu_1',
  acrossExperienceIds: ['exp_1', 'exp_2', 'exp_3'],
  distinctPeople: 3,
  basis: [
    { kind: 'cluster', id: 'clu_1' },
    { kind: 'experience', id: 'exp_1' },
  ],
  lifecycleState: 'active' as const,
  summary: 'Three accounts from three people describe the same failure',
  rationale: 'They share a confirmed entity and issue type, so this is one failure reported more than once.',
  confidence: 0.7,
  ...overrides,
});

test('a conclusion over enough experiences and people is drawn', () => {
  const conclusion = expect(drawConclusion(conclusionInput()), 'draw');
  assert.equal(conclusion.kind, 'recurring_failure');
  assert.equal(conclusion.acrossExperienceIds.length, 3);
  assert.equal(conclusion.basis.length, 2);
});

test('a conclusion with no openable basis is refused at creation, not filtered at display', () => {
  // The failure test the phase names: insufficient evidence.
  const empty = drawConclusion(conclusionInput({ basis: [] }));
  assert.equal(empty.ok, false);
  assert.equal(!empty.ok && empty.error.code, 'basis_required');

  const junk = drawConclusion(conclusionInput({ basis: [{ kind: 'vibes', id: 'x' }, { kind: 'experience', id: '' }] }));
  assert.equal(junk.ok, false, 'a reference to nothing openable is no reference');
  assert.equal(!junk.ok && junk.error.code, 'basis_required');
});

test('a pattern over one experience is not a pattern', () => {
  const one = drawConclusion(conclusionInput({ acrossExperienceIds: ['exp_1'] }));
  assert.equal(one.ok, false);
  assert.equal(!one.ok && one.error.code, 'not_enough_experiences');
  assert.equal(MINIMUM_EXPERIENCES, 2);
});

test('several accounts from one person is not a pattern either', () => {
  const one = drawConclusion(conclusionInput({ distinctPeople: 1 }));
  assert.equal(one.ok, false);
  assert.equal(!one.ok && one.error.code, 'not_enough_people');
  assert.equal(MINIMUM_PEOPLE, 2);
});

test('duplicate experience ids do not inflate the span', () => {
  const padded = drawConclusion(conclusionInput({ acrossExperienceIds: ['exp_1', 'exp_1', 'exp_1'] }));
  assert.equal(padded.ok, false, 'one experience named three times is still one experience');
});

test('no conclusion is drawn over an expired signal', () => {
  const stale = drawConclusion(conclusionInput({ lifecycleState: 'expired' }));
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.error.code, 'signal_expired');
});

test('a conclusion is keyed on what it is about, not when it was drawn', () => {
  const first = expect(drawConclusion(conclusionInput()), 'first');
  const laterSameThing = expect(
    drawConclusion(conclusionInput({ acrossExperienceIds: ['exp_3', 'exp_1', 'exp_2'], confidence: 0.9 })),
    'second',
  );
  assert.equal(conclusionKeyOf(first), conclusionKeyOf(laterSameThing), 'reached by another walk, same key');

  const different = expect(drawConclusion(conclusionInput({ acrossExperienceIds: ['exp_1', 'exp_9'] })), 'other');
  assert.notEqual(conclusionKeyOf(first), conclusionKeyOf(different));
});

test('every conclusion kind is a named one', () => {
  const unknown = drawConclusion(conclusionInput({ kind: 'a_hunch' }));
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error.code, 'unknown_conclusion_kind');
  assert.ok(CONCLUSION_KINDS.length >= 4);
});

test('a conclusion cannot act', () => {
  assert.equal(enactConclusion(), undefined);
});

// ── P59 action plans ──────────────────────────────────────────────────────
const step = (command: string, targetEngine = 'E9', input: Record<string, unknown> = {}) => ({
  command,
  targetEngine,
  input,
});

test('a plan is drafted from an approved proposal, with steps in order', () => {
  const plan = expect(
    draftPlan({
      proposalId: 'prp_1',
      subjectId: 'clu_1',
      steps: [step('case.open', 'E9', { organizationId: 'org_1' }), step('escalation.review', 'E10')],
    }),
    'draft',
  );
  assert.deepEqual(plan.steps.map((item) => item.order), [1, 2]);
  assert.equal(plan.steps[0]?.command, 'case.open');
});

test('a plan without an approved proposal is not a plan', () => {
  const orphan = draftPlan({ proposalId: '', subjectId: 'clu_1', steps: [step('case.open')] });
  assert.equal(orphan.ok, false);
  assert.equal(!orphan.ok && orphan.error.code, 'proposal_required');
});

test('no step may delete, dispute a claim, or declare a resolution', () => {
  // The three prohibitions, checked here because a plan is another way to ask.
  for (const command of ['experience.delete', 'creator.deleteExperience', 'dispute_claim.open', 'mark_resolved']) {
    const refused = draftPlan({ proposalId: 'prp_1', subjectId: 'clu_1', steps: [step(command)] });
    assert.equal(refused.ok, false, `${command} is refused`);
    assert.equal(!refused.ok && refused.error.code, 'step_forbidden');
  }
  assert.deepEqual(
    forbiddenCommandsIn([{ order: 1, command: 'purge_everything', input: {}, targetEngine: 'E9' }]),
    ['purge_everything'],
  );
});

test('a step cannot target the proposer', () => {
  const loop = draftPlan({ proposalId: 'prp_1', subjectId: 'clu_1', steps: [step('proposal.create', 'E12')] });
  assert.equal(loop.ok, false);
  assert.equal(!loop.ok && loop.error.code, 'step_cannot_target_intelligence');
});

test('a plan must not repeat the same step', () => {
  const doubled = draftPlan({
    proposalId: 'prp_1',
    subjectId: 'clu_1',
    steps: [step('case.open', 'E9', { organizationId: 'org_1' }), step('case.open', 'E9', { organizationId: 'org_1' })],
  });
  assert.equal(doubled.ok, false);
  assert.equal(!doubled.ok && doubled.error.code, 'duplicate_step');
});

test('a plan longer than the cap is refused', () => {
  const long = draftPlan({
    proposalId: 'prp_1',
    subjectId: 'clu_1',
    steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => step(`case.step${index}`)),
  });
  assert.equal(long.ok, false);
  assert.equal(!long.ok && long.error.code, 'too_many_steps');
});

test('malformed steps are refused rather than coerced', () => {
  for (const steps of [[], 'not-an-array', [null], [{ targetEngine: 'E9' }], [{ command: 'x' }], [{ command: 'case.open', targetEngine: 'E9', input: 'nope' }]]) {
    const refused = draftPlan({ proposalId: 'prp_1', subjectId: 'clu_1', steps });
    assert.equal(refused.ok, false, `${JSON.stringify(steps)} is refused`);
  }
});

const steps: readonly PlanStep[] = [
  { order: 1, command: 'case.open', input: {}, targetEngine: 'E9' },
  { order: 2, command: 'case.transition', input: {}, targetEngine: 'E9' },
];

test('a plan is complete only when every step dispatched', () => {
  const all: readonly StepOutcome[] = [
    { order: 1, dispatched: true },
    { order: 2, dispatched: true },
  ];
  assert.equal(planStatusFrom(steps, all), 'completed');
});

test('one step refused is partial, and partial is a normal outcome', () => {
  // The failure test the phase names: action-plan partial failure.
  const partial: readonly StepOutcome[] = [
    { order: 1, dispatched: true },
    { order: 2, dispatched: false, error: 'not_a_member: you do not act for that organization' },
  ];
  assert.equal(planStatusFrom(steps, partial), 'partially_completed');
});

test('a plan where nothing dispatched has failed, not partially succeeded', () => {
  const none: readonly StepOutcome[] = [
    { order: 1, dispatched: false, error: 'policy_insufficient_role: refused' },
    { order: 2, dispatched: false, error: 'policy_insufficient_role: refused' },
  ];
  assert.equal(planStatusFrom(steps, none), 'failed');
});

test('a plan with no outcomes yet is pending, not complete', () => {
  assert.equal(planStatusFrom(steps, []), 'pending');
});

test('a plan neither schedules itself nor writes anything itself', () => {
  assert.equal(schedulePlan(), undefined);
  assert.equal(planCanMutateDirectly(), false);
});
