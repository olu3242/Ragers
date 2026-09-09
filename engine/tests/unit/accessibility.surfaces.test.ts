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
  assert.match(layout, /aria-label="Main"/, 'navigation is labelled');
  assert.match(layout, /<main id="main">/, 'there is a main landmark');
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
    ['Composer.tsx', 'ReactionRow.tsx', 'SignalRow.tsx', 'VoicePlayer.tsx', 'VoiceRecorder.tsx'],
    'a new component must be added to the accessibility gate',
  );
});
