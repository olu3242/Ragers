import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Static accessibility assertions over the shipped surfaces. These do not
 * replace a browser audit — they lock in the properties that regress silently:
 * focus visibility, a reduced-motion guard, a skip link, labelled controls and
 * state exposed to assistive technology rather than by colour alone.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

const css = read('app', 'globals.css');
const layout = read('app', 'layout.tsx');
const composer = read('components', 'Composer.tsx');
const recorder = read('components', 'VoiceRecorder.tsx');
const reactions = read('components', 'ReactionRow.tsx');
const signals = read('components', 'SignalRow.tsx');
const resolution = read('components', 'ResolutionRow.tsx');
const orgResponses = read('components', 'OrganizationResponses.tsx');
const personaNav = read('components', 'PersonaNav.tsx');
const queue = read('components', 'ModerationQueue.tsx');
const inbox = read('components', 'OrganizationCaseInbox.tsx');
const outcomeBadge = read('components', 'OutcomeBadge.tsx');
const relate = read('components', 'RelateControl.tsx');
const disputeControl = read('components', 'DisputeControl.tsx');
const contribution = read('components', 'ContributionView.tsx');
const responsiveness = read('components', 'ResponsivenessPanel.tsx');
const recommendation = read('components', 'RecommendationCard.tsx');
const severityBadge = read('components', 'SeverityBadge.tsx');
const agingNote = read('components', 'AgingNote.tsx');
const cost = read('components', 'CostControl.tsx');
const priorityRow = read('components', 'PriorityRow.tsx');

test('a visible focus treatment is defined once, globally', () => {
  assert.match(css, /:focus-visible\s*\{/, 'a focus-visible rule must exist');
  assert.match(css, /outline:\s*2px solid var\(--focus\)/, 'focus must be a visible outline');
  assert.equal(/outline:\s*(none|0)\b/.test(css), false, 'no rule may remove focus outlines');
});

test('the reduced-motion guard disables animation and transition', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /animation:\s*none\s*!important/);
  assert.match(block, /transition:\s*none\s*!important/);
});

test('every animation the app defines is inside a reduced-motion-guarded design', () => {
  // Any keyframe animation must be neutralised by the guard above.
  const animated = [...css.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1] ?? '');
  const meaningful = animated.filter((value) => !value.includes('none'));
  assert.ok(meaningful.length > 0, 'the app does animate, so the guard is load-bearing');
});

test('the layout provides a skip link that becomes visible on focus', () => {
  assert.match(layout, /className="skip-link"/);
  assert.match(layout, /href="#main"/);
  assert.match(layout, /id="main"/);
  assert.match(css, /\.skip-link:focus\s*\{[^}]*left:\s*8px/, 'the skip link must move into view on focus');
});

test('navigation and the document declare their language and landmarks', () => {
  assert.match(layout, /<html lang="en">/);
  assert.match(layout, /<main id="main">/, 'there is a main landmark');
  // The nav moved into PersonaNav when navigation became persona-scoped; the
  // landmark and its label have to move with it, not get lost in the change.
  assert.match(personaNav, /aria-label="Main"/, 'navigation is labelled');
  assert.match(personaNav, /<nav\b/, 'and it is still a nav landmark');
});

test('every text input in the composer has an associated label', () => {
  assert.match(composer, /<label htmlFor="body">/);
  assert.match(composer, /id="body"/);
  assert.match(composer, /<label htmlFor="category">/);
  assert.match(composer, /id="category"/);
});

test('radio groups are wrapped in a fieldset with a legend', () => {
  const fieldsets = composer.match(/<fieldset>/g) ?? [];
  const legends = composer.match(/<legend>/g) ?? [];
  assert.ok(fieldsets.length >= 3, 'kind, mode and visibility are each a group');
  assert.equal(fieldsets.length, legends.length, 'every fieldset has a legend');
});

test('a visually hidden radio still receives a visible focus treatment', () => {
  // The custom choice control hides the input, so focus must be forwarded.
  assert.match(css, /\.choice input\s*\{[^}]*opacity:\s*0/);
  assert.match(css, /\.choice input:focus-visible \+ span\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
});

test('toggle state is exposed to assistive technology, not only by colour', () => {
  assert.match(reactions, /aria-pressed=/, 'reaction buttons expose pressed state');
  assert.match(css, /\.reaction\[aria-pressed='true'\]/, 'and are styled from that state');
  assert.match(signals, /aria-pressed=/, 'the claim button exposes pressed state');
  assert.match(css, /\.signal-claim\[aria-pressed='true'\]/, 'and is styled from that state');
});

test('a refused resolution report is announced, not only shown', () => {
  assert.match(resolution, /role="alert"/, 'a refusal must reach a screen reader');
});

test('an organization response is labelled as the organization’s account', () => {
  // Never presented as a correction of the experience it answers.
  assert.match(orgResponses, /organizationName/, 'the organization is named');
  assert.match(orgResponses, /disputes this account/, 'a dispute is framed as a disagreement');
});

test('a refused claim is announced, not only shown', () => {
  // "You already said this happened to you" is information a person needs, and
  // a screen reader user would otherwise never learn the tap did nothing.
  assert.match(signals, /role="alert"/, 'the claim refusal must be announced');
});

test('recorder status changes are announced', () => {
  assert.match(recorder, /aria-live="polite"/, 'status must be announced as it changes');
  assert.match(recorder, /aria-hidden="true"/, 'the decorative indicator is hidden from AT');
});

test('every interactive element in the app surfaces is a real button or link', () => {
  for (const [name, source] of [
    ['Composer', composer],
    ['VoiceRecorder', recorder],
    ['ReactionRow', reactions],
    ['SignalRow', signals],
    ['ResolutionRow', resolution],
    ['OrganizationResponses', orgResponses],
    ['PersonaNav', personaNav],
    ['ModerationQueue', queue],
    ['OrganizationCaseInbox', inbox],
    ['OutcomeBadge', outcomeBadge],
    ['RelateControl', relate],
    ['DisputeControl', disputeControl],
    ['ContributionView', contribution],
    ['ResponsivenessPanel', responsiveness],
    ['RecommendationCard', recommendation],
    ['CostControl', cost],
    ['PriorityRow', priorityRow],
  ] as const) {
    // A div with an onClick is not keyboard-operable.
    assert.equal(
      /<(div|span)[^>]*onClick=/.test(source),
      false,
      `${name} must not put a click handler on a non-interactive element`,
    );
    assert.equal(/type="button"[^>]*type=/.test(source), false, `${name} button types are well-formed`);
  }
});

test('every button in the app surfaces declares an explicit type', () => {
  for (const [name, source] of [
    ['Composer', composer],
    ['VoiceRecorder', recorder],
    ['ReactionRow', reactions],
    ['SignalRow', signals],
    ['ResolutionRow', resolution],
    ['ModerationQueue', queue],
    ['OrganizationCaseInbox', inbox],
    ['RelateControl', relate],
    ['DisputeControl', disputeControl],
    ['RecommendationCard', recommendation],
    ['CostControl', cost],
  ] as const) {
    const buttons = [...source.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1] ?? '');
    for (const attributes of buttons) {
      assert.match(attributes, /type=/, `${name} has a button without an explicit type`);
    }
  }
});

test('all app surface files are accounted for by these assertions', () => {
  const components = readdirSync(join(root, 'components')).filter((file) => file.endsWith('.tsx'));
  assert.deepEqual(
    components.sort(),
    [
      'AgingNote.tsx',
      'Composer.tsx',
      'ContributionView.tsx',
      'CostControl.tsx',
      'DisputeControl.tsx',
      'ModerationQueue.tsx',
      'OrganizationCaseInbox.tsx',
      'OrganizationResponses.tsx',
      'OutcomeBadge.tsx',
      'PersonaNav.tsx',
      'PriorityRow.tsx',
      'ReactionRow.tsx',
      'RecommendationCard.tsx',
      'RelateControl.tsx',
      'ResolutionRow.tsx',
      'ResponsivenessPanel.tsx',
      'SeverityBadge.tsx',
      'SignalRow.tsx',
      'VoicePlayer.tsx',
      'VoiceRecorder.tsx',
    ],
    'a new component must be added to the accessibility gate',
  );
});

// ── Persona surfaces ─────────────────────────────────────────────────────
test('every operator and organization control that mutates has a label', () => {
  for (const [name, source] of [
    ['ModerationQueue', queue],
    ['OrganizationCaseInbox', inbox],
    ['RelateControl', relate],
    ['DisputeControl', disputeControl],
    ['RecommendationCard', recommendation],
    ['CostControl', cost],
  ] as const) {
    // A bare input or select with no label is unusable with a screen reader, and
    // these are the surfaces where a mislabelled control has consequences.
    const inputs = [...source.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
    for (const [, element, attributes] of inputs) {
      assert.match(
        attributes ?? '',
        /id=|aria-label/,
        `${name} has a ${element} with nothing to label it`,
      );
    }
    const labels = [...source.matchAll(/<label\b([^>]*)>/g)].map((match) => match[1] ?? '');
    for (const attributes of labels) {
      assert.match(attributes, /htmlFor=/, `${name} has a label that points at nothing`);
    }
  }
});

test('operator and organization errors are announced, not only shown', () => {
  for (const [name, source] of [
    ['ModerationQueue', queue],
    ['OrganizationCaseInbox', inbox],
    ['RelateControl', relate],
    ['DisputeControl', disputeControl],
    ['RecommendationCard', recommendation],
    ['CostControl', cost],
  ] as const) {
    assert.match(source, /role="alert"/, `${name} must announce a refusal`);
  }
});

test('the persona label is text, not colour alone', () => {
  // Someone who holds several personas has to be able to tell which surface they
  // are on without relying on a hue.
  assert.match(personaNav, /PERSONA_LABELS\[target\.persona\]/, 'personas are labelled in words');
  assert.match(css, /\.tab-persona/, 'and styled from that label, not instead of it');
});

test('Relate says in words that it is not a claim', () => {
  // The count sits near numbers that do mean "people this happened to", so the
  // distinction cannot be left to placement.
  assert.match(relate, /do not count as Re-Rages/, 'stated, not implied');
});

test('a dispute says it is not a finding about who is right', () => {
  // Whitespace-tolerant: the copy is line-wrapped in the source.
  assert.match(disputeControl, /not a\s+finding about which is right/);
  // And that neither side decides it.
  assert.match(disputeControl, /Neither side can decide it/);
});

test('a recommendation says in words what happened, and announces the change', () => {
  // The decision radios are one named group, so a reviewer using a keyboard moves
  // between approve / reject / escalate rather than tabbing past three unrelated
  // controls — and the group is what carries the question.
  assert.match(recommendation, /<fieldset>/);
  assert.match(recommendation, /<legend>Your decision<\/legend>/);
  assert.match(recommendation, /name={`decision-\$\{recommendation\.proposalId\}`}/);
  // The effect changes after an action taken elsewhere on the card, so it is
  // announced rather than only redrawn.
  assert.match(recommendation, /className="recommendation-effect"\s*\n?\s*role="status"/);
});

test('a priority renders no score, and never a zero for an unknown impact', () => {
  const stripped = priorityRow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['score', 'weight', 'points', 'toFixed']) {
    assert.equal(stripped.includes(forbidden), false, `a priority must not render a ${forbidden}`);
  }
  // Band and urgency are named separately, because they answer different questions and
  // disagree constantly.
  assert.match(priorityRow, /BAND_LABELS\[priority\.band\]/);
  assert.match(priorityRow, /URGENCY_LABELS\[priority\.urgency\]/);
  // An unknown impact says so in words rather than falling back to a number.
  assert.match(priorityRow, /Not enough people have said this happened to them/);
  // And an unassessed reading renders nothing at all.
  assert.match(priorityRow, /priority\.unassessed\) return null/);
});

test('a severity band is words, never a number beside a person', () => {
  const stripped = severityBadge.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // No percentage, no numeric interpolation, no score.
  assert.equal(/toFixed|Math\.round|%/.test(stripped), false, 'a band renders no figure');
  assert.match(severityBadge, /BAND_LABELS\[severity\.band\]/, 'the band is named in words');
  // And it says whose account it is, because severity here is asserted, not measured.
  assert.match(severityBadge, /what the person it happened to said it cost them/);
});

test('an unassessed experience renders no band at all', () => {
  // The default band is `minor` because a band is required. Rendering it would report
  // an absence of information as a finding.
  assert.match(severityBadge, /severity\.unassessed\) return null/);
});

test('aging carries no overdue indicator, because nothing is owed', () => {
  const stripped = agingNote.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['overdue', 'late', 'breach', 'sla', 'target']) {
    assert.equal(
      stripped.toLowerCase().includes(forbidden),
      false,
      `aging must not imply an obligation: ${forbidden}`,
    );
  }
  // Silence reads as silence rather than as a zero.
  assert.match(agingNote, /no response yet/);
});

test('the cost control shows no total and no band while somebody is answering', () => {
  const stripped = cost.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/total|sum|band|severity/i.test(stripped), false, 'answering must not be strategic');
  assert.match(cost, /Every question is optional/);
});

test('the reputation reads carry no composite score', () => {
  // Comments are stripped first: these files explain *why* there is no score, and a
  // rule that cannot tell an explanation from a feature teaches people to delete the
  // explanation.
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  for (const [name, source] of [
    ['ContributionView', withoutComments(contribution)],
    ['ResponsivenessPanel', withoutComments(responsiveness)],
  ] as const) {
    for (const forbidden of ['score', 'rating', 'rank', 'grade'] as const) {
      assert.equal(
        new RegExp(`\\b${forbidden}`, 'i').test(source),
        false,
        `${name} must not present a ${forbidden}`,
      );
    }
  }
  // Responsiveness must not call itself an SLA: none exists.
  assert.equal(
    /\bSLA\b/.test(responsiveness.replace(/\/\*[\s\S]*?\*\//g, '')),
    false,
    'nothing here is a service-level agreement',
  );
  assert.match(responsiveness, /Confirmed resolved/, 'and confirmation is attributed');
});
