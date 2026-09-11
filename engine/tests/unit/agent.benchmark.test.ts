import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENTS,
  AGENT_ACTIONS,
  AGENT_IDS,
  agentCanMutate,
  authorise,
  declarationFor,
  forbiddenTypesIn,
  validateDeclaration,
  type AgentDeclaration,
} from '../../src/domain/agent.ts';
import { createDeterministicAssistanceProvider } from '../../src/adapters/fakes.ts';
import { benchmarkNamesOrganizations } from '../../src/engines/benchmark.engine.ts';

/**
 * Phases 44–47 at the domain layer.
 *
 * The Phase 45 certification is a negative — *no agent can exceed its defined domain
 * permissions, asserted by attempting the excess and being refused* — so most of this file
 * attempts the excess.
 */

// ── Phase 45 — the framework's boundary ─────────────────────────────────
test('there is no write verb, so no agent can mutate anything', () => {
  // The property the whole band rests on. `AgentAction` has three members and none of them
  // writes, so there is no request an agent could make that reaches an E1–E11 table.
  assert.deepEqual([...AGENT_ACTIONS], ['read', 'propose', 'escalate']);
  for (const action of AGENT_ACTIONS) {
    assert.equal(/write|mutate|apply|delete|set/.test(action), false, `${action} must not be a write`);
  }
  assert.equal(agentCanMutate(), false);
});

test('an agent reading an engine it did not declare is refused, for that reason', () => {
  // The trust agent declares E4 only. Asking for E1 must fail as `engine_not_declared` —
  // not as something vaguer, because a refusal for the wrong reason hides a real hole.
  const refused = authorise(AGENTS.trust, { agentId: 'trust', action: 'read', engine: 'E1' });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, 'engine_not_declared');
    assert.equal(refused.error.details?.['refusal'], 'engine_not_declared');
  }
});

test('an agent proposing a type it did not declare is refused', () => {
  const refused = authorise(AGENTS.matching, {
    agentId: 'matching',
    action: 'propose',
    proposalType: 'remove_content',
    confidence: 0.99,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'proposal_type_not_declared');
});

test('an unregistered agent is refused as unknown, not silently allowed', () => {
  const refused = authorise(declarationFor('nonexistent'), {
    agentId: 'trust',
    action: 'read',
    engine: 'E4',
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'unknown_agent');
});

test('below its confidence floor an agent must escalate rather than propose', () => {
  const refused = authorise(AGENTS.moderation, {
    agentId: 'moderation',
    action: 'propose',
    proposalType: 'review_content',
    confidence: 0.4,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, 'below_confidence_floor');
    // The refusal says where to take it, because "no" without a next step is a dead end.
    assert.match(refused.error.message, /escalate to moderator/);
  }
});

test('a declared request at or above every floor is allowed', () => {
  // Phase 91 added two more floors to clear — a declared target engine and enough cited rows —
  // so a request that clears only the confidence floor is no longer sufficient. That is the
  // point of the phase rather than a change in this test's intent.
  const allowed = authorise(AGENTS.moderation, {
    agentId: 'moderation',
    action: 'propose',
    proposalType: 'review_content',
    confidence: 0.7,
    targetEngine: 'E9',
    evidenceCount: 2,
  });
  assert.equal(allowed.ok, true);
});

// ── Phase 46 — the three prohibitions, checked across the whole registry ─
test('no agent anywhere may propose deletion, dispute of a claim, or a resolution', () => {
  // Checked over every agent rather than only the organization one: an agent acting for an
  // organization inherits its prohibitions and cannot be granted more, and the way to keep
  // that true as agents are added is to check the whole registry.
  for (const id of AGENT_IDS) {
    const declaration = AGENTS[id];
    assert.deepEqual(
      [...forbiddenTypesIn(declaration)],
      [],
      `${id} declares a forbidden proposal type`,
    );
    assert.equal(validateDeclaration(declaration).ok, true, `${id} must be a valid declaration`);
  }
});

test('a declaration containing a forbidden type is refused at validation', () => {
  const rogue: AgentDeclaration = {
    ...AGENTS.organization_response,
    proposalTypes: ['declare_resolved'],
  };
  const refused = validateDeclaration(rogue);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'forbidden_proposal_type');
});

test('the organization agent may draft and suggest, and nothing else', () => {
  const declaration = AGENTS.organization_response;
  assert.deepEqual([...declaration.proposalTypes], ['draft_organization_response', 'suggest_remediation']);
  assert.deepEqual([...declaration.readsEngines], ['E9', 'E10']);
  assert.equal(declaration.escalatesTo, 'organization');
});

test('every agent declares a purpose, a floor and a retry budget', () => {
  for (const id of AGENT_IDS) {
    const declaration = AGENTS[id];
    assert.ok(declaration.purpose.length > 0, `${id} must say what it is for`);
    assert.ok(declaration.confidenceFloor > 0 && declaration.confidenceFloor <= 1, id);
    assert.ok(declaration.maxAttempts >= 1 && declaration.maxAttempts <= 5, `${id} does not retry forever`);
  }
});

// ── Phase 44 — the provider boundary ────────────────────────────────────
test('the deterministic provider reports itself as not live', () => {
  // The honest answer, and the one the harness reads: this is not a model, so
  // live-provider behaviour is untested rather than passing.
  assert.equal(createDeterministicAssistanceProvider().live, false);
});

test('a suggestion invents no references — it returns a subset of what it was given', async () => {
  const provider = createDeterministicAssistanceProvider();
  const result = await provider.assist({
    task: 'summarise_pattern',
    context: [{ label: 'kind rage', text: 'rage' }],
    references: [{ kind: 'experience', id: 'exp_1' }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.value.references], [{ kind: 'experience', id: 'exp_1' }]);
  // And it says it did not interpret anything, so a reader can tell it apart from a model.
  assert.match(result.value.rationale, /No model is configured/);
});

test('a suggestion with nothing to check is refused rather than produced', async () => {
  const result = await createDeterministicAssistanceProvider().assist({
    task: 'summarise_pattern',
    context: [],
    references: [],
  });
  // `proposal.create` would refuse it anyway; refusing here means a reviewer's attention is
  // never spent on it.
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'assistance_needs_references');
});

test('an unavailable provider fails, and is retryable rather than internal', async () => {
  const result = await createDeterministicAssistanceProvider({ failing: true }).assist({
    task: 'summarise_pattern',
    context: [],
    references: [{ kind: 'experience', id: 'exp_1' }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'assistance_unavailable');
    // A provider being down is a condition to retry, never a reason to produce a
    // suggestion with nothing behind it.
    assert.equal(result.error.retryable, true);
  }
});

test('the deterministic provider is below most agents’ floors, so they escalate', async () => {
  const result = await createDeterministicAssistanceProvider().assist({
    task: 'review_content',
    context: [],
    references: [{ kind: 'experience', id: 'exp_1' }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The difference between "we have no model" and "we have a model that is very sure about
  // nothing".
  const refused = authorise(AGENTS.moderation, {
    agentId: 'moderation',
    action: 'propose',
    proposalType: 'review_content',
    confidence: result.value.confidence,
  });
  assert.equal(refused.ok, false);
});

test('a domain violation and low confidence are different outcomes', () => {
  // Found by a failing test rather than by review: the runner originally recorded both as
  // `escalated`, which would have made an agent exceeding its declaration look like
  // ordinary caution — and the one query somebody runs after an incident ("what did agents
  // try to do that they were not allowed to?") would have returned nothing.
  const outsideDomain = authorise(AGENTS.organization_response, {
    agentId: 'organization_response',
    action: 'propose',
    proposalType: 'declare_resolved',
    confidence: 0.99,
  });
  const notConfident = authorise(AGENTS.organization_response, {
    agentId: 'organization_response',
    action: 'propose',
    proposalType: 'draft_organization_response',
    confidence: 0.1,
  });
  assert.equal(outsideDomain.ok, false);
  assert.equal(notConfident.ok, false);
  if (!outsideDomain.ok && !notConfident.ok) {
    assert.notEqual(outsideDomain.error.code, notConfident.error.code);
    assert.equal(notConfident.error.code, 'below_confidence_floor');
  }
});

// ── Phase 47 ────────────────────────────────────────────────────────────
test('a benchmark never names an organization', () => {
  assert.equal(benchmarkNamesOrganizations(), false);
});
