const fs = require('fs');
const assert = require('assert');

const landing = fs.readFileSync('index.html','utf8');
const app = fs.readFileSync('app.html','utf8');
const js = fs.readFileSync('app.js','utf8');

assert(landing.includes('app.html#create'), 'Landing Rager CTA must route to app composer');
assert(landing.includes('app.html'), 'Landing sign-in/create account must route to app');
assert(app.includes('value="public"') && app.includes('value="alias"') && app.includes('value="anonymous"'), 'All identity modes must exist');
assert(app.includes('value="rager"') && app.includes('value="rave"'), 'Both content types must exist');
assert(js.includes("visibility === 'anonymous'"), 'Anonymous display handling must exist');
assert(js.includes('data-delete-post'), 'Self-delete path must exist');
assert(js.includes('localStorage'), 'Preview persistence must exist');

const banned = [
  'Behavioral Signal Graph','Behavioral Friction Graph','Ragers OS','Experience OS','Behavior OS','Trust OS','Runtime OS',
  'trust-score methodology','growth flywheel','data moat','competitive moat','Future APIs','commercial behavioral intelligence'
];
for (const file of ['index.html','app.html','styles.css','app.css','script.js','app.js']) {
  const text = fs.readFileSync(file,'utf8').toLowerCase();
  for (const term of banned) assert(!text.includes(term.toLowerCase()), `${term} leaked into ${file}`);
}
console.log('Ragers Phase 1 smoke checks: PASS');
