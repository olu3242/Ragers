import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DECISION_OUTCOMES,
  ENGINE_LABELS,
  decisionNeedsNote,
  describeConfidence,
  describeEffect,
  engineLabel,
  isDecidable,
} from '../../lib/proposals.ts';
import { ENGINE_IDS } from '../../src/domain/proposal.ts';

/**
 * The reviewer's side of E12.
 *
 * These assertions are about one thing: a reviewer must never be told an action
 * happened when the governed engine refused it. The engine records the decision
 * and the effect separately; if the surface collapses them, that separation buys
 * nothing, and the collapse is silent — which is why it is tested here rather
 * than left to a browser pass.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

test('every engine has a plain-words label — a reviewer is never shown a bare E-number', () => {
  for (const engine of ENGINE_IDS) {
    const label = engineLabel(engine);
    assert.ok(label.length > 0, `${engine} needs a label`);
    assert.equal(/^E\d+$/.test(label), false, `${engine} must not be labelled with its own id`);
  }
  assert.equal(Object.keys(ENGINE_LABELS).length, ENGINE_IDS.length);
});

test('an approval the target engine refused never reads as an action that happened', () => {
  const refused = describeEffect({
    status: 'approved',
    targetEngine: 'E9',
    proposedCommand: 'moderation.action',
    dispatched: false,
    dispatchError: 'policy_self_action: a moderator cannot act on their own content',
  });
  assert.match(refused, /refused/);
  assert.match(refused, /Nothing was applied/);
  // The engine's own words, verbatim: a paraphrase loses the reason.
  assert.match(refused, /policy_self_action/);
});

test('an approval that took effect says so, and is worded differently from one that did not', () => {
  const done = describeEffect({
    status: 'approved',
    targetEngine: 'E9',
    proposedCommand: 'moderation.action',
    dispatched: true,
  });
  const notDone = describeEffect({
    status: 'approved',
    targetEngine: 'E9',
    proposedCommand: 'moderation.action',
    dispatched: false,
  });
  assert.match(done, /carried it out/);
  assert.match(notDone, /has not carried it out/);
  assert.notEqual(done, notDone);
});

test('an approved recommendation with no action attached does not imply one ran', () => {
  const advice = describeEffect({ status: 'approved', targetEngine: 'E4' });
  assert.match(advice, /named no action/);
  assert.match(advice, /nothing was applied/i);
});

test('every undecided state says nothing has been applied', () => {
  for (const status of ['proposed', 'escalated', 'expired'] as const) {
    const effect = describeEffect({ status, targetEngine: 'E8', proposedCommand: 'resolution.report' });
    assert.match(effect, /nothing has been applied|Nothing was applied/i, `${status}`);
  }
});

test('escalation is not a decision: an escalated recommendation is still decidable', () => {
  assert.equal(isDecidable('proposed'), true);
  assert.equal(isDecidable('escalated'), true);
  for (const settled of ['approved', 'rejected', 'expired'] as const) {
    assert.equal(isDecidable(settled), false, settled);
  }
});

test('rejecting demands a reason and approving does not', () => {
  assert.equal(decisionNeedsNote('rejected'), true);
  assert.equal(decisionNeedsNote('approved'), false);
  assert.equal(decisionNeedsNote('escalated'), false);
  assert.deepEqual([...DECISION_OUTCOMES], ['approved', 'rejected', 'escalated']);
});

test('confidence is stated as the proposer’s estimate, never as a finding', () => {
  const described = describeConfidence(0.82);
  assert.match(described, /82%/);
  assert.match(described, /estimate/);
  assert.match(described, /not a finding/);
  // Out-of-range input is clamped rather than rendered as nonsense.
  assert.match(describeConfidence(1.4), /100%/);
  assert.match(describeConfidence(-0.2), /0%/);
});

test('the reviewer card reports the effect the engine returned, not its own guess', () => {
  const card = read('components', 'RecommendationCard.tsx');
  // It must read `dispatched` and `dispatchError` off the response; a card that
  // ignored them would show "Approved" for a refused approval.
  assert.match(card, /body\.dispatched/);
  assert.match(card, /body\.dispatchError/);
  assert.match(card, /describeEffect\(/);
});

test('the two proposal kinds stay separate sections, and only one is a reviewer’s to decide', () => {
  const page = read('app', 'operate', 'proposals', 'page.tsx');
  assert.match(page, /recommendations-section/);
  assert.match(page, /unconfirmed-section/);
  // The unconfirmed-structure section renders no decision component.
  const unconfirmed = page.slice(page.indexOf('unconfirmed-section'));
  assert.equal(
    /RecommendationCard/.test(unconfirmed),
    false,
    'structure only its author can confirm must carry no decision control',
  );
});
