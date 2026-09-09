/**
 * Public-surface smoke checks.
 *
 * These guard the contract of the shipped landing page and app shell, plus the
 * content-separation rule in CLAUDE.md. The engine has its own suite
 * (`cd engine && npm test`); this file deliberately stays dependency-free so it
 * runs anywhere the static site does.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const landing = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');
const js = fs.readFileSync('app.js', 'utf8');

// ── Landing page routes into the product ─────────────────────────────────
assert(landing.includes('app.html#create'), 'Landing Rager CTA must route to app composer');
assert(landing.includes('app.html'), 'Landing sign-in/create account must route to app');

// ── Core product contract ────────────────────────────────────────────────
assert(
  app.includes('value="public"') && app.includes('value="alias"') && app.includes('value="anonymous"'),
  'All identity modes must exist',
);
assert(app.includes('value="rager"') && app.includes('value="rave"'), 'Both content types must exist');
assert(js.includes("visibility === 'anonymous'"), 'Anonymous display handling must exist');
assert(js.includes('data-delete-post'), 'Self-delete path must exist');
assert(js.includes('localStorage'), 'Preview persistence must exist');

// ── Privacy copy is load-bearing (AGENTS.md #3) ──────────────────────────
assert(/id="privacy"/.test(landing), 'The privacy section must not be removed');
assert(/identifying details/i.test(landing), 'The identity-protection promise must remain on the page');

// ── No debug output left in shipped scripts ──────────────────────────────
for (const file of ['script.js', 'app.js']) {
  const text = fs.readFileSync(file, 'utf8');
  assert(!/console\.(log|debug|dir)\s*\(/.test(text), `Debug output left in ${file}`);
}

// ── Content separation: banned terms must not reach any public surface ────
const banned = [
  'Behavioral Signal Graph',
  'Behavioral Friction Graph',
  'Ragers OS',
  'Experience OS',
  'Behavior OS',
  'Trust OS',
  'Runtime OS',
  'trust-score methodology',
  'growth flywheel',
  'data moat',
  'competitive moat',
  'Future APIs',
  'commercial behavioral intelligence',
  'orchestration architecture',
  'event architecture',
  'anti-brigading',
  'ranking algorithm',
  'calibration formula',
  'Privacy Shield',
  'investor thesis',
  'monetization strategy',
  'organization intelligence',
  'proprietary resolution detection',
  'moderation orchestration',
  'behavioral intelligence',
];

/** Collect every file that a visitor can see the source of. */
const publicSurfaces = () => {
  const files = ['index.html', 'app.html', 'styles.css', 'app.css', 'script.js', 'app.js'];
  // The app UI is a public surface too — CLAUDE.md is explicit about that.
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join('engine', 'app'));
  walk(path.join('engine', 'components'));
  return files;
};

const surfaces = publicSurfaces();
assert(surfaces.length >= 6, 'Public surface list must include the landing page and app shell');

for (const file of surfaces) {
  const text = fs.readFileSync(file, 'utf8').toLowerCase();
  for (const term of banned) {
    assert(!text.includes(term.toLowerCase()), `${term} leaked into ${file}`);
  }
}

console.log(`Ragers public-surface smoke checks: PASS (${surfaces.length} surfaces scanned)`);
