import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME_COPY,
  presentOutcome,
  PROPOSAL_RESPONSE_KINDS,
  type OutcomePresentation,
} from '../../src/domain/outcome-presentation.ts';
import { navFor } from '../../lib/nav.ts';

/**
 * The five states a viewer must never confuse.
 *
 * The one with the most at stake is `proposed_resolution`: an organization has
 * described a fix and nobody it happened to has confirmed it. Reading that as
 * "resolved" would let a company close a case by asserting it closed, which is the
 * single misreading this product cannot permit.
 */
test('an organization describing a fix is a proposal, not a resolution', () => {
  const presentation = presentOutcome({
    status: 'acknowledged',
    hasResponse: true,
    hasProposedResolution: true,
    reporters: 0,
  });
  assert.equal(presentation, 'proposed_resolution');
  assert.notEqual(presentation, 'resolved');
  assert.match(OUTCOME_COPY[presentation].explanation, /have not confirmed/);
  assert.equal(OUTCOME_COPY[presentation].clarifies, true, 'and it says so unprompted');
});

test('the experiencers’ verdict outranks anything the organization said', () => {
  // A described fix plus a confirmation is resolved; a described fix that the
  // people it happened to reject is not.
  assert.equal(
    presentOutcome({ status: 'resolved', hasResponse: true, hasProposedResolution: true, reporters: 2 }),
    'resolved',
  );
  assert.equal(
    presentOutcome({ status: 'open', hasResponse: true, hasProposedResolution: true, reporters: 2 }),
    'unresolved_reported',
  );
});

test('a response alone is distinguished from a proposal and from silence', () => {
  assert.equal(
    presentOutcome({ status: 'acknowledged', hasResponse: true, hasProposedResolution: false, reporters: 0 }),
    'response_only',
  );
  assert.equal(
    presentOutcome({ status: 'open', hasResponse: false, hasProposedResolution: false, reporters: 0 }),
    'unresolved_unreported',
  );
  assert.notEqual(
    OUTCOME_COPY.unresolved_unreported.explanation,
    OUTCOME_COPY.unresolved_reported.explanation,
    'nobody having spoken is not the same as everybody saying no',
  );
});

test('a dispute says the accounts differ, never who is right', () => {
  const copy = OUTCOME_COPY[presentOutcome({
    status: 'disputed',
    hasResponse: true,
    hasProposedResolution: false,
    reporters: 1,
  })];
  assert.equal(copy.badge, 'Disputed');
  assert.match(copy.explanation, /Both accounts stand/);
  for (const word of ['false', 'untrue', 'wrong', 'incorrect']) {
    assert.equal(
      copy.explanation.toLowerCase().includes(word),
      false,
      `a dispute must not adjudicate ("${word}")`,
    );
  }
});

test('every state has copy, and none of it uses internal vocabulary', () => {
  const states: readonly OutcomePresentation[] = [
    'unresolved_unreported',
    'unresolved_reported',
    'response_only',
    'proposed_resolution',
    'partially_resolved',
    'resolved',
    'disputed',
  ];
  // The public-language rule from CLAUDE.md, applied to the words a viewer sees.
  const banned = ['signal graph', 'trust score', 'moat', 'flywheel', 'orchestration', 'runtime'];
  for (const state of states) {
    const copy = OUTCOME_COPY[state];
    assert.ok(copy, `${state} has copy`);
    assert.ok(copy.badge.length > 0 && copy.explanation.length > 0);
    for (const term of banned) {
      assert.equal(
        `${copy.badge} ${copy.explanation}`.toLowerCase().includes(term),
        false,
        `${state} leaks internal vocabulary: ${term}`,
      );
    }
  }
});

test('only a described fix counts as a proposal', () => {
  assert.ok(PROPOSAL_RESPONSE_KINDS.includes('publish_resolution'));
  assert.ok(PROPOSAL_RESPONSE_KINDS.includes('remediation_instructions'));
  for (const kind of ['acknowledge', 'respond', 'dispute', 'request_information', 'known_incident']) {
    assert.equal(
      PROPOSAL_RESPONSE_KINDS.includes(kind),
      false,
      `${kind} is a response, not a proposed resolution`,
    );
  }
});

// ── Persona navigation ───────────────────────────────────────────────────
test('a consumer is offered no operator or organization surface', () => {
  const targets = navFor(['consumer'], []);
  assert.deepEqual(targets.map((target) => target.href), ['/', '/compose']);
});

test('organization tabs are named per organization, so nobody speaks as the wrong one', () => {
  const targets = navFor(
    ['consumer', 'community', 'organization'],
    [
      { id: 'org_a', displayName: 'Northwind Air' },
      { id: 'org_b', displayName: 'Southgale Rail' },
    ],
  );
  const labels = targets.filter((target) => target.persona === 'organization').map((t) => t.label);
  assert.deepEqual(labels, ['Northwind Air', 'Southgale Rail']);
});

test('an operator gets the queue and the proposals surface', () => {
  const targets = navFor(['consumer', 'community', 'operator', 'intelligence'], []);
  const hrefs = targets.map((target) => target.href);
  assert.ok(hrefs.includes('/operate'));
  assert.ok(hrefs.includes('/operate/proposals'));
});

test('navigation scoping is presentation only, never the authorization', () => {
  // Asserted as a property of the code: the nav builder takes no actor and makes
  // no authorization decision, so it cannot become the thing that protects a
  // surface. The policy matrix does that.
  assert.equal(navFor.length, 2, 'personas and organizations — no actor, no capability check');
});
