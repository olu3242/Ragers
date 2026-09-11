import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENTS,
  AGENT_IDS,
  authorise,
  authoriseWithActor,
  satisfiesAuthority,
  validateDeclaration,
  type AgentDeclaration,
} from '../../src/domain/agent.ts';
import {
  CONTROL_CONSEQUENCES,
  CONTROL_KINDS,
  controlCanDeleteData,
  controlDecidesAProposal,
  controlKeyOf,
  validateControl,
} from '../../src/domain/operator-control.ts';
import {
  EXPLAINABLE_MODULES,
  explainMeasure,
  explanationProblems,
  isWellFormed,
  opaqueCompositeIsAuthoritative,
  sampleFrom,
  withheldExplanation,
  type Explanation,
} from '../../src/domain/explanation.ts';
import {
  CONTAINMENT,
  FAILURE_CLASSES,
  PAGING_CLASSES,
  containmentChangesARefusal,
  describeContainment,
  oneFailureStopsEverything,
} from '../../src/domain/containment.ts';
import { measure } from '../../src/domain/sampling.ts';

/**
 * Phases 91, 92, 94 and 95 as pure rules.
 *
 * The theme of this band is that every mechanism already worked and none of them was *stated*. So
 * most of these assertions are about a contract rather than about a computation: that a declaration
 * cannot promise less than the domain, that an explanation cannot be silently absent, that a
 * control names what it applies to.
 */

// ── Phase 91: default deny ───────────────────────────────────────────────
const propose = (agentId: (typeof AGENT_IDS)[number], overrides: Record<string, unknown> = {}) => {
  const declaration = AGENTS[agentId];
  return authorise(declaration, {
    agentId,
    action: 'propose',
    proposalType: declaration.proposalTypes[0]!,
    confidence: declaration.confidenceFloor,
    targetEngine: declaration.targetEngines[0]!,
    evidenceCount: declaration.evidenceFloor,
    ...overrides,
  });
};

test('every agent declares its full authority, and every declaration validates', () => {
  for (const id of AGENT_IDS) {
    const declaration = AGENTS[id];
    assert.equal(validateDeclaration(declaration).ok, true, `${id} validates`);
    assert.ok(declaration.targetEngines.length > 0, `${id} says what it aims at`);
    assert.ok(declaration.forbiddenCommands.length > 0, `${id} forbids something`);
    assert.ok(declaration.evidenceFloor >= 1, `${id} must cite something`);
    assert.ok(['escalate', 'skip'].includes(declaration.degradedBehaviour), `${id} has a degraded plan`);
  }
});

test('a proposal aimed at an engine the agent did not declare is refused', () => {
  // Reading an engine you should not see is a disclosure; proposing *into* one is an attempt to
  // act, and the two are refused under different names so a trail can tell them apart.
  const refused = propose('intake', { targetEngine: 'E4' });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'target_engine_not_declared');
});

test('an agent may not target E12, so a proposal cannot loop through the proposal engine', () => {
  for (const id of AGENT_IDS) {
    assert.equal(AGENTS[id].targetEngines.includes('E12'), false, `${id} does not target E12`);
  }
  const looping: AgentDeclaration = { ...AGENTS.intake, targetEngines: ['E12'] };
  const invalid = validateDeclaration(looping);
  assert.equal(invalid.ok, false);
  assert.equal(!invalid.ok && invalid.error.code, 'cannot_target_e12');
});

test('a forbidden command is refused even for a request that is otherwise fine', () => {
  const refused = propose('moderation', { command: 'safety.applyModerationAction' });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'command_forbidden');
});

test('the evidence floor is enforced separately from confidence', () => {
  // **A model can be confident about nothing.** A maximally confident proposal citing no rows is
  // exactly the shape this floor exists for, so confidence is set high on purpose here.
  const refused = propose('trend', { confidence: 1, evidenceCount: 0 });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'below_evidence_floor');
  assert.match(refused.ok ? '' : refused.error.message, /escalate to/);
});

test('a pattern agent needs two rows and a single-subject agent needs one', () => {
  assert.equal(AGENTS.trend.evidenceFloor, 2, 'a pattern over one row is not a pattern');
  assert.equal(AGENTS.matching.evidenceFloor, 2);
  assert.equal(AGENTS.resolution.evidenceFloor, 1, 'the experience is the thing to open');
  assert.equal(propose('trend', { evidenceCount: 1 }).ok, false);
  assert.equal(propose('resolution', { evidenceCount: 1 }).ok, true);
});

test('a paused agent is refused before anything else is even considered', () => {
  // Refused at the authority layer rather than hidden in a surface. Everything else about the
  // request is valid, so this asserts the pause is what stopped it.
  const refused = propose('intake', { paused: true });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'agent_paused');
});

test('agent authority is not actor authority, and neither substitutes for the other', () => {
  const declaration = AGENTS.moderation;
  assert.equal(declaration.requiredAuthority, 'moderator');

  // A member cannot act on it, however well-formed the agent's side is.
  const asMember = authoriseWithActor(
    declaration,
    {
      agentId: 'moderation',
      action: 'propose',
      proposalType: 'review_content',
      confidence: 0.7,
      targetEngine: 'E9',
      evidenceCount: 1,
    },
    { role: 'member' },
  );
  assert.equal(asMember.ok, false);
  assert.equal(!asMember.ok && asMember.error.code, 'authority_insufficient');

  // And an admin cannot widen the agent's own declaration. Being the most privileged person in
  // the system does not let you aim an agent somewhere it never said it aims.
  const asAdmin = authoriseWithActor(
    declaration,
    {
      agentId: 'moderation',
      action: 'propose',
      proposalType: 'review_content',
      confidence: 0.7,
      targetEngine: 'E1',
      evidenceCount: 1,
    },
    { role: 'admin' },
  );
  assert.equal(asAdmin.ok, false);
  assert.equal(!asAdmin.ok && asAdmin.error.code, 'target_engine_not_declared');
});

test('required authority is the role ladder and nothing else', () => {
  // The correction kept as an assertion: `organization` is not a role. An organization membership
  // is a fact about which organization somebody may act for, and it is asked elsewhere.
  assert.equal(satisfiesAuthority('admin', 'moderator'), true);
  assert.equal(satisfiesAuthority('moderator', 'moderator'), true);
  assert.equal(satisfiesAuthority('member', 'moderator'), false);
  assert.equal(satisfiesAuthority('guest', 'moderator'), false);
  assert.equal(satisfiesAuthority('organization', 'moderator'), false, 'not a role at all');
  for (const id of AGENT_IDS) {
    assert.ok(
      ['moderator', 'admin'].includes(AGENTS[id].requiredAuthority),
      `${id} states its authority in the role vocabulary`,
    );
  }
});

test('a declaration that forbids nothing, or cites nothing, does not validate', () => {
  const permissive: AgentDeclaration = { ...AGENTS.intake, forbiddenCommands: [] };
  assert.equal(validateDeclaration(permissive).ok, false, 'default deny');
  const uncheckable: AgentDeclaration = { ...AGENTS.intake, evidenceFloor: 0 };
  assert.equal(validateDeclaration(uncheckable).ok, false, 'a proposal nobody can check is not one');
});

// ── Phase 92: explainability ─────────────────────────────────────────────
test('a withheld measure explains why it is withheld rather than being absent', () => {
  // **The failure mode is silence, not a lie.** A measure that simply does not appear leaves the
  // surface to show a blank, and a reader fills a blank with a guess.
  const explanation = withheldExplanation('how often they respond', 'responsiveness', 2);
  assert.equal(isWellFormed(explanation), true);
  assert.ok(explanation.withheld);
  assert.match(explanation.withheld, /2 of the 5/);
  assert.equal(explanation.sample?.clears, false);
  assert.ok(explanation.conclusion.length > 0, 'and it still says something honest');
});

test('a stated conclusion with no named factors is refused as an opaque composite', () => {
  const opaque: Explanation = {
    conclusion: 'This organization is good.',
    factors: [],
    basis: [{ kind: 'experience', id: 'exp_1' }],
    confidence: 0.9,
    sample: sampleFrom('approval_rate', 10),
    staleness: undefined,
    withheld: undefined,
  };
  const problems = explanationProblems(opaque);
  assert.equal(problems.length > 0, true);
  assert.match(problems.join(' '), /opaque composite/);
  assert.equal(opaqueCompositeIsAuthoritative(), false);
});

test('an explanation cannot be both withheld and carry factors', () => {
  const both: Explanation = {
    ...withheldExplanation('anything', 'approval_rate', 1),
    factors: [{ name: 'corroboration', direction: 'raises', detail: 'three people' }],
  };
  assert.match(explanationProblems(both).join(' '), /withheld but carrying factors/);
});

test('explainMeasure carries the real sample size on both branches', () => {
  const withheld = explainMeasure('the approval rate', 'approval_rate', measure('approval_rate', 2, () => 0.5), () => ({
    conclusion: 'unreachable',
    factors: [],
    basis: [],
    confidence: undefined,
    staleness: undefined,
  }));
  assert.equal(withheld.sample?.size, 2, 'the size it actually had, not the floor');
  assert.ok(withheld.withheld);

  const reported = explainMeasure('the approval rate', 'approval_rate', measure('approval_rate', 9, () => 0.5), (value) => ({
    conclusion: `The approval rate is ${value}.`,
    factors: [{ name: 'approvals', direction: 'raises', detail: 'nine reports' }],
    basis: [{ kind: 'experience', id: 'exp_1' }],
    confidence: undefined,
    staleness: undefined,
  }));
  assert.equal(reported.sample?.size, 9);
  assert.equal(reported.withheld, undefined);
  assert.equal(isWellFormed(reported), true);
});

test('every module that decides something is listed as explainable', () => {
  // The list is of modules rather than function names, so adding a decision to a listed module is
  // covered automatically and adding a new module is the thing a reviewer notices.
  assert.ok(EXPLAINABLE_MODULES.length >= 7);
  assert.equal(new Set(EXPLAINABLE_MODULES).size, EXPLAINABLE_MODULES.length, 'no duplicates');
});

// ── Phase 94: the controls ───────────────────────────────────────────────
test('every control names what it applies to, and there is no wildcard', () => {
  for (const kind of CONTROL_KINDS) {
    assert.ok(CONTROL_CONSEQUENCES[kind].length > 0, `${kind} says what it refuses`);
    for (const wildcard of ['*', 'all', 'ANY', 'everything', '', '   ']) {
      const refused = validateControl({ kind, target: wildcard }, 'because');
      assert.equal(refused.ok, false, `${kind} refuses "${wildcard}"`);
    }
    assert.equal(validateControl({ kind, target: 'something' }, 'because').ok, true);
  }
});

test('a control with no reason is refused', () => {
  // The next operator's first question is "why is this paused", and a control with no reason is a
  // control nobody dares release.
  assert.equal(validateControl({ kind: 'pause_agent', target: 'intake' }, '').ok, false);
  assert.equal(validateControl({ kind: 'pause_agent', target: 'intake' }, '   ').ok, false);
  assert.equal(validateControl({ kind: 'pause_agent', target: 'intake' }, 'x'.repeat(501)).ok, false);
});

test('a control is keyed by kind and target, so the same one cannot be in force twice', () => {
  assert.equal(controlKeyOf({ kind: 'pause_agent', target: 'intake' }), 'pause_agent:intake');
  assert.notEqual(
    controlKeyOf({ kind: 'pause_agent', target: 'intake' }),
    controlKeyOf({ kind: 'disable_proposal_type', target: 'intake' }),
  );
});

test('no control deletes anything, and none decides a proposal', () => {
  assert.equal(controlCanDeleteData(), false);
  // `refuse_pending_action` holds rather than rejects. Rejecting on an operator's behalf would put
  // a decision in the ledger the reviewer did not make — `decision != effect` cuts both ways.
  assert.equal(controlDecidesAProposal(), false);
  assert.match(CONTROL_CONSEQUENCES.refuse_pending_action, /not decided, rejected or deleted/);
});

// ── Phase 95: containment ────────────────────────────────────────────────
test('every failure class states its blast radius and what still works', () => {
  for (const failure of FAILURE_CLASSES) {
    const containment = CONTAINMENT[failure];
    assert.ok(containment.blastRadius.length > 20, `${failure} says what breaks`);
    assert.ok(containment.unaffected.length > 20, `${failure} says what does not`);
    assert.ok(['automatic', 'retried', 'needs_a_person'].includes(containment.recovery));
    // Both halves, always. A report listing only what broke reads as a total outage to somebody
    // scanning it under pressure.
    assert.match(describeContainment(failure), /Still working:/);
  }
});

test('only a store outage stops everything, and it says so itself', () => {
  for (const failure of FAILURE_CLASSES) {
    assert.equal(
      oneFailureStopsEverything(failure),
      failure === 'store_unavailable',
      `${failure} is contained unless it is the store`,
    );
  }
  assert.match(CONTAINMENT.store_unavailable.blastRadius, /no containment/);
});

test('a partial plan failure is a normal outcome rather than an error', () => {
  // Authorization is evaluated per step at execution time, so a plan whose later steps a reviewer
  // may not perform is supposed to stop there.
  assert.match(CONTAINMENT.partial_plan_failure.unaffected, /normal outcome/);
  assert.equal(CONTAINMENT.partial_plan_failure.pages, false);
});

test('the paging classes are derived rather than listed twice', () => {
  assert.deepEqual([...PAGING_CLASSES].sort(), ['store_unavailable', 'worker_crash']);
  for (const failure of PAGING_CLASSES) assert.equal(CONTAINMENT[failure].pages, true);
  assert.equal(containmentChangesARefusal(), false);
});
