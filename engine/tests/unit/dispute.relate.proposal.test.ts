import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionDispute,
  DISPUTE_REASONS,
  isContested,
  openDispute,
  reviewDispute,
  withdrawDispute,
  type Dispute,
} from '../../src/domain/dispute.ts';
import {
  canonicalPair,
  createRelation,
  distinctAsserters,
  relationKey,
  retractRelation,
  trustWeightOfRelations,
  type ExperienceRelation,
} from '../../src/domain/relation.ts';
import {
  canTransitionProposal,
  createProposal,
  decideProposal,
  expireProposal,
  type IntelligenceProposal,
} from '../../src/domain/proposal.ts';

const NOW = 1_700_000_000_000;
const META = { id: 'x_1', correlationId: 'corr_1', now: NOW };

// ── E10 formal dispute ───────────────────────────────────────────────────
const consumerDispute = (overrides: Partial<Dispute> = {}): Dispute => {
  const opened = openDispute(
    {
      experienceId: 'exp_1',
      origin: 'experiencer',
      raisedBy: 'actor_a',
      reason: 'response_misleading',
      detail: 'The refund they describe never arrived.',
    },
    META,
  );
  assert.ok(opened.ok);
  return { ...(opened.ok ? opened.value : ({} as Dispute)), ...overrides };
};

test('a dispute is not a rejection, not unresolved, and not resolved', () => {
  const dispute = consumerDispute();
  assert.equal(dispute.status, 'open');
  // Nothing in the dispute type carries a resolution status: they are separate
  // objects on separate axes, which is the whole reason this table exists.
  assert.equal('resolutionStatus' in dispute, false);
  assert.equal(isContested([dispute]), true);
});

test('each side may only raise reasons that make sense for it', () => {
  // An organization cannot claim a fix was not delivered to it.
  const wrongWay = openDispute(
    { experienceId: 'exp_1', origin: 'organization', organizationId: 'org_1', raisedBy: 'actor_s', reason: 'fix_not_delivered' },
    META,
  );
  assert.equal(wrongWay.ok, false);
  assert.equal(wrongWay.ok === false && wrongWay.error.code, 'reason_not_available_to_origin');

  // And a consumer cannot claim it is the wrong entity as the entity.
  const alsoWrong = openDispute(
    { experienceId: 'exp_1', origin: 'experiencer', raisedBy: 'actor_a', reason: 'wrong_entity' },
    META,
  );
  assert.equal(alsoWrong.ok === false && alsoWrong.error.code, 'reason_not_available_to_origin');

  const right = openDispute(
    { experienceId: 'exp_1', origin: 'organization', organizationId: 'org_1', raisedBy: 'actor_s', reason: 'wrong_entity' },
    META,
  );
  assert.equal(right.ok, true);
});

test('"other" without an explanation is refused, because it is unreviewable', () => {
  const vague = openDispute(
    { experienceId: 'exp_1', origin: 'experiencer', raisedBy: 'actor_a', reason: 'other' },
    META,
  );
  assert.equal(vague.ok === false && vague.error.code, 'detail_required');
});

test('an organization dispute must name the organization; a consumer one must not', () => {
  const unnamed = openDispute(
    { experienceId: 'exp_1', origin: 'organization', raisedBy: 'actor_s', reason: 'wrong_entity' },
    META,
  );
  assert.equal(unnamed.ok === false && unnamed.error.code, 'organization_required');

  const overreaching = openDispute(
    {
      experienceId: 'exp_1',
      origin: 'experiencer',
      raisedBy: 'actor_a',
      organizationId: 'org_1',
      reason: 'account_inaccurate',
    },
    META,
  );
  assert.equal(overreaching.ok === false && overreaching.error.code, 'organization_not_permitted');
});

test('only the raiser withdraws, and withdrawal is idempotent', () => {
  const dispute = consumerDispute();
  const byOther = withdrawDispute(dispute, 'actor_b', NOW);
  assert.equal(byOther.ok === false && byOther.error.code, 'not_your_dispute');

  const withdrawn = withdrawDispute(dispute, 'actor_a', NOW);
  assert.ok(withdrawn.ok);
  assert.equal(withdrawn.ok && withdrawn.value.status, 'withdrawn');
  assert.equal(withdrawn.ok && withdrawn.value.withdrawnAt, NOW);

  const again = withdrawDispute(withdrawn.ok ? withdrawn.value : dispute, 'actor_a', NOW + 1);
  assert.equal(again.ok && again.value.withdrawnAt, NOW, 'unchanged on a repeat');
});

test('the disputed party cannot decide it, and neither can the raiser', () => {
  const dispute = consumerDispute();
  const selfServing = reviewDispute(dispute, { to: 'declined', reviewerId: 'actor_a' }, NOW);
  assert.equal(selfServing.ok === false && selfServing.error.code, 'cannot_review_own_dispute');

  // A moderator can. That is the only path, and it is attributed.
  const decided = reviewDispute(dispute, { to: 'upheld', reviewerId: 'actor_mod', note: 'Checked.' }, NOW);
  assert.ok(decided.ok);
  assert.equal(decided.ok && decided.value.reviewedBy, 'actor_mod');
  assert.equal(decided.ok && decided.value.reviewedAt, NOW);
});

test('under_review is a holding state, not a decision', () => {
  const held = reviewDispute(consumerDispute(), { to: 'under_review', reviewerId: 'actor_mod' }, NOW);
  assert.ok(held.ok);
  assert.equal(held.ok && held.value.status, 'under_review');
  assert.equal(held.ok && held.value.reviewedAt, undefined, 'nothing has been decided yet');
});

test('a settled dispute is final: a new grievance is a new dispute', () => {
  for (const settled of ['upheld', 'declined', 'withdrawn'] as const) {
    for (const to of ['open', 'under_review', 'upheld', 'declined'] as const) {
      assert.equal(canTransitionDispute(settled, to), false, `${settled} → ${to}`);
    }
  }
});

test('a withdrawn or declined dispute stops marking an experience contested', () => {
  const open = consumerDispute();
  assert.equal(isContested([open]), true);
  assert.equal(isContested([{ ...open, status: 'withdrawn' }]), false);
  assert.equal(isContested([{ ...open, status: 'declined' }]), false);
  assert.equal(
    isContested([{ ...open, status: 'upheld' }]),
    false,
    'a decided dispute is history, not a permanent shadow',
  );
  assert.equal(isContested([{ ...open, status: 'under_review' }]), true);
});

test('every reason is available to at least one side', () => {
  for (const reason of DISPUTE_REASONS) {
    const asConsumer = openDispute(
      { experienceId: 'e', origin: 'experiencer', raisedBy: 'a', reason, detail: 'because' },
      META,
    );
    const asOrganization = openDispute(
      { experienceId: 'e', origin: 'organization', organizationId: 'o', raisedBy: 's', reason, detail: 'because' },
      META,
    );
    assert.ok(asConsumer.ok || asOrganization.ok, `${reason} is raisable by somebody`);
  }
});

// ── E6 Relate ────────────────────────────────────────────────────────────
const relation = (overrides: Partial<ExperienceRelation> = {}): ExperienceRelation => {
  const created = createRelation(
    { fromExperienceId: 'exp_b', toExperienceId: 'exp_a', assertedBy: 'actor_a', bothPublished: true },
    META,
  );
  assert.ok(created.ok);
  return { ...(created.ok ? created.value : ({} as ExperienceRelation)), ...overrides };
};

test('relating carries no trust weight, ever', () => {
  const many = Array.from({ length: 100 }, (_unused, index) =>
    relation({ assertedBy: `actor_${index}` }),
  );
  assert.equal(
    trustWeightOfRelations(many),
    0,
    'a hundred assertions buy no credibility — this is the rule that stops Relate becoming a trust market',
  );
});

test('the pair is canonicalised, so A→B and B→A are one assertion', () => {
  assert.deepEqual(canonicalPair('exp_b', 'exp_a'), { from: 'exp_a', to: 'exp_b' });
  assert.equal(
    relationKey('exp_b', 'exp_a', 'actor_a'),
    relationKey('exp_a', 'exp_b', 'actor_a'),
    'one person relating two experiences is one edge whichever way round they said it',
  );
});

test('an experience cannot be related to itself, and both must be published', () => {
  const itself = createRelation(
    { fromExperienceId: 'exp_a', toExperienceId: 'exp_a', assertedBy: 'actor_a', bothPublished: true },
    META,
  );
  assert.equal(itself.ok === false && itself.error.code, 'cannot_relate_to_itself');

  const unpublished = createRelation(
    { fromExperienceId: 'exp_a', toExperienceId: 'exp_b', assertedBy: 'actor_a', bothPublished: false },
    META,
  );
  assert.equal(unpublished.ok === false && unpublished.error.code, 'experience_not_published');
});

test('only the asserter retracts, the row survives, and retraction is idempotent', () => {
  const row = relation();
  const byOther = retractRelation(row, 'actor_b', NOW);
  assert.equal(byOther.ok === false && byOther.error.code, 'not_your_relation');

  const retracted = retractRelation(row, 'actor_a', NOW);
  assert.ok(retracted.ok);
  assert.equal(retracted.ok && retracted.value.status, 'retracted');
  assert.equal(retracted.ok && retracted.value.id, row.id, 'the row survives so aggregates recompute');
  const again = retractRelation(retracted.ok ? retracted.value : row, 'actor_a', NOW + 1);
  assert.equal(again.ok && again.value.retractedAt, NOW);
});

test('distinct asserters counts people, and ignores retracted assertions', () => {
  const rows = [
    relation({ assertedBy: 'actor_a' }),
    relation({ assertedBy: 'actor_a' }),
    relation({ assertedBy: 'actor_b' }),
    relation({ assertedBy: 'actor_c', status: 'retracted' }),
  ];
  assert.equal(distinctAsserters(rows), 2);
});

// ── E12 governed proposals ───────────────────────────────────────────────
const proposal = (overrides: Partial<IntelligenceProposal> = {}): IntelligenceProposal => {
  const created = createProposal(
    {
      proposalType: 'suppress_coordinated_cluster',
      sourceEngine: 'E12',
      targetEngine: 'E4',
      subjectId: 'exp_1',
      summary: 'Six accounts corroborated within four minutes.',
      rationale: 'Burst detection flagged a coordinated window; see the risk event.',
      confidence: 0.72,
      evidenceRefs: [{ kind: 'risk_event', id: 'risk_1' }],
      proposedCommand: 'safety.applyModerationAction',
      proposedInput: { targetType: 'experience', targetId: 'exp_1', action: 'no_action', reason: 'reviewed' },
    },
    META,
  );
  assert.ok(created.ok);
  return { ...(created.ok ? created.value : ({} as IntelligenceProposal)), ...overrides };
};

test('a proposal without traceable evidence is refused, not shown', () => {
  const untraceable = createProposal(
    {
      proposalType: 'x',
      sourceEngine: 'E12',
      targetEngine: 'E4',
      subjectId: 'exp_1',
      summary: 'Something looks off.',
      rationale: 'It just does.',
      confidence: 0.9,
      evidenceRefs: [],
    },
    META,
  );
  assert.equal(untraceable.ok === false && untraceable.error.code, 'evidence_required');
});

test('a proposal cannot target the proposer', () => {
  const loop = createProposal(
    {
      proposalType: 'x',
      sourceEngine: 'E12',
      targetEngine: 'E12',
      subjectId: 'exp_1',
      summary: 's',
      rationale: 'r',
      confidence: 0.5,
      evidenceRefs: [{ kind: 'experience', id: 'exp_1' }],
    },
    META,
  );
  assert.equal(loop.ok === false && loop.error.code, 'target_cannot_be_intelligence');
});

test('a proposal records the command it wants, so approval is of a specific action', () => {
  const row = proposal();
  assert.equal(row.proposedCommand, 'safety.applyModerationAction');
  assert.deepEqual(row.proposedInput['targetId'], 'exp_1');
  assert.equal(row.status, 'proposed');
  // Nothing on the proposal is a piece of E1–E11 state.
  for (const key of Object.keys(row)) {
    assert.equal(
      /^(status|resolutionStatus)$/.test(key) && key === 'resolutionStatus',
      false,
      'a proposal holds no governed engine state',
    );
  }
});

test('rejecting requires saying why', () => {
  const silent = decideProposal(proposal(), { to: 'rejected', reviewerId: 'actor_mod' }, NOW);
  assert.equal(silent.ok === false && silent.error.code, 'note_required');

  const explained = decideProposal(
    proposal(),
    { to: 'rejected', reviewerId: 'actor_mod', note: 'The window is a news cycle, not coordination.' },
    NOW,
  );
  assert.ok(explained.ok);
  assert.match(explained.ok ? (explained.value.reviewNote ?? '') : '', /news cycle/);
});

test('escalation is not a decision: an escalated proposal can still be decided', () => {
  assert.ok(canTransitionProposal('proposed', 'escalated'));
  assert.ok(canTransitionProposal('escalated', 'approved'));
  assert.ok(canTransitionProposal('escalated', 'rejected'));
  for (const decided of ['approved', 'rejected', 'expired'] as const) {
    assert.equal(canTransitionProposal(decided, 'approved'), false, `${decided} is final`);
  }
});

test('confidence must be a real number in range', () => {
  for (const confidence of [-0.1, 1.1, Number.NaN, 'high' as unknown as number]) {
    const bad = createProposal(
      {
        proposalType: 'x',
        sourceEngine: 'E12',
        targetEngine: 'E4',
        subjectId: 'exp_1',
        summary: 's',
        rationale: 'r',
        confidence,
        evidenceRefs: [{ kind: 'experience', id: 'exp_1' }],
      },
      META,
    );
    assert.equal(bad.ok, false, `${String(confidence)} is not a confidence`);
  }
});

test('expiry needs an expiry time that has passed, and is unattributed', () => {
  const noDeadline = expireProposal(proposal(), NOW);
  assert.equal(noDeadline.ok === false && noDeadline.error.code, 'not_yet_expired');

  const future = expireProposal(proposal({ expiresAt: NOW + 1_000 }), NOW);
  assert.equal(future.ok === false && future.error.code, 'not_yet_expired');

  const due = expireProposal(proposal({ expiresAt: NOW - 1 }), NOW);
  assert.ok(due.ok);
  assert.equal(due.ok && due.value.status, 'expired');
  assert.equal(due.ok && due.value.reviewedBy, undefined, 'time passing is not a reviewer');
});
