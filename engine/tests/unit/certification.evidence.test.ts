import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countsOf,
  evidenceFor,
  excerptOf,
  failuresOf,
  MAX_ASSERTION_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_FAILURES_RETAINED,
  redact,
  type RunnerOutcome,
} from '../../src/certification/evidence.ts';
import {
  buildReport,
  conclusionOf,
  decideStatus,
  decideExperienceLoopStatus,
  mergeAttempt,
  renderLedger,
  type GateResult,
} from '../../src/certification/harness.ts';

/**
 * Certification evidence.
 *
 * The gap this closes was found the honest way: an intermittent gate failure turned CI
 * red, and what the harness had kept was `10/11 assertions passed, 1 failed`. Enough to
 * know something broke; not enough to know what, so the answer cost a blind re-run —
 * and the re-run passed, which told nobody anything about the first failure.
 *
 * The parsing used to live in `scripts/certify.ts`, which is why it had no tests at all.
 * These are those tests.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');

const outcome = (overrides: Partial<RunnerOutcome> = {}): RunnerOutcome => ({
  command: ['node', '--test', 'tests/unit/example.test.ts'],
  exitCode: 1,
  stdout: '',
  stderr: '',
  durationMs: 1_234,
  ...overrides,
});

// ── The end-to-end proof, against a real runner ───────────────────────────
test('a real failing run keeps the failing subtest name, its assertion and its location', () => {
  // Run the deliberate-failure fixture for real. A fixture string pasted into this file
  // would prove the parser matches what I remember TAP looking like, which is not the
  // property under test.
  // `NODE_TEST_CONTEXT` is cleared deliberately. Node's test runner refuses to nest —
  // it warns "run() is being called recursively" and exits **0** having run nothing, so
  // without this the child looks like a pass and this test would prove nothing at all.
  // The `notEqual` below is what caught that, which is why it is an assertion rather
  // than an assumption.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const run = spawnSync('node', ['--test', 'tests/fixtures/deliberate-failure.test.ts'], {
    cwd: engineRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.notEqual(run.status, 0, 'the fixture fails on purpose');
  assert.ok((run.stdout ?? '').includes('not ok'), 'and the child actually ran its tests');

  const evidence = evidenceFor({
    command: ['node', '--test', 'tests/fixtures/deliberate-failure.test.ts'],
    exitCode: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    durationMs: 900,
  });

  assert.equal(evidence.exitCode, 1, 'the exit code is retained');
  assert.equal(evidence.counts.tests, 3);
  assert.equal(evidence.counts.passed, 1);
  assert.equal(evidence.counts.failed, 2);

  const names = evidence.failureSummary.map((failure) => failure.test);
  assert.ok(
    names.includes('the deliberate failure: an asserted refusal that did not happen'),
    `the failing subtest is named: ${JSON.stringify(names)}`,
  );
  assert.ok(
    names.includes('the deliberate failure with a multi-line assertion'),
    'and so is the second one',
  );
  assert.ok(
    !names.includes('a passing test beside the failing one, so the run is not all red'),
    'the passing one is not',
  );

  const first = evidence.failureSummary.find(
    (failure) => failure.test === 'the deliberate failure: an asserted refusal that did not happen',
  );
  assert.ok(first, 'the first failure is present');
  assert.match(first.assertion ?? '', /the boundary must refuse this input/, 'the assertion message survives');
  assert.match(first.assertion ?? '', /false !== true/, 'including what it compared');
  assert.match(first.location ?? '', /deliberate-failure\.test\.ts:\d+/, 'and where it was');

  // The detail line names the failure rather than only counting it. This is the whole
  // point: reading the ledger should answer "which one", not just "how many".
  assert.match(evidence.detail, /first failure: the deliberate failure/);
  assert.match(evidence.detail, /1\/3 assertions passed, 2 failed/);

  assert.ok(evidence.evidenceExcerpt, 'an excerpt is kept');
  assert.ok(evidence.evidenceExcerpt.length <= MAX_EXCERPT_CHARS + 32, 'and it is bounded');
  assert.match(evidence.evidenceExcerpt, /not ok/, 'and it contains the failure region');
});

// ── Bounds ────────────────────────────────────────────────────────────────
test('output is bounded — a runaway suite does not become the ledger', () => {
  const many = Array.from(
    { length: 40 },
    (_, index) => `not ok ${index + 1} - failure number ${index}\n  ---\n  error: 'it broke'\n  ...`,
  ).join('\n');
  const evidence = evidenceFor(outcome({ stdout: `TAP version 13\n${many}\n# tests 40\n# pass 0\n# fail 40\n` }));

  assert.equal(evidence.failureSummary.length, MAX_FAILURES_RETAINED, 'the retained set is capped');
  assert.equal(evidence.failuresOmitted, 40 - MAX_FAILURES_RETAINED, 'and the rest are counted, not silently dropped');
  assert.ok((evidence.evidenceExcerpt ?? '').length <= MAX_EXCERPT_CHARS + 32);
});

test('a single enormous assertion is trimmed rather than carried whole', () => {
  const huge = 'x'.repeat(10_000);
  const evidence = evidenceFor(
    outcome({ stdout: `not ok 1 - a test\n  ---\n  error: '${huge}'\n  ...\n# tests 1\n# pass 0\n# fail 1\n` }),
  );
  const assertion = evidence.failureSummary[0]?.assertion ?? '';
  assert.ok(assertion.length <= MAX_ASSERTION_CHARS + 16, `trimmed, was ${assertion.length}`);
  assert.match(assertion, /truncated/, 'and says it was trimmed rather than pretending to be whole');
});

// ── Redaction ─────────────────────────────────────────────────────────────
test('credential shapes are redacted', () => {
  const cases: readonly [string, RegExp][] = [
    ['connecting to postgres://ragers:hunter2@db.internal:5432/prod', /\[REDACTED\]@/],
    ['Authorization: Bearer abcdefghijklmnop1234567890', /Bearer \[REDACTED\]/],
    ['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', /\[REDACTED_TOKEN\]/],
    ['SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturesig', /\[REDACTED/],
    ['DATABASE_URL=postgres://user:pw@host/db', /\[REDACTED\]/],
    ['MY_API_KEY: s3cr3tvalue123', /MY_API_KEY=\[REDACTED\]/],
  ];
  for (const [input, expected] of cases) {
    const out = redact(input);
    assert.match(out, expected, `redacted: ${input}`);
    assert.ok(!/hunter2|s3cr3tvalue123/.test(out), `the value is gone from: ${out}`);
  }
});

test('redaction leaves test names and assertions alone, including ones about secrets', () => {
  // The rule is shape, not vocabulary. A test named for a secret is exactly the
  // evidence this module exists to preserve, so redacting the word would defeat it.
  const names = [
    'a short secret is a signature anybody can forge',
    'the signing secret is never returned by any read path',
    'a token in an event payload is a token in the outbox',
    'expected password_reset to be refused',
    'DATABASE_URL is required',
  ];
  for (const name of names) {
    assert.equal(redact(name), name, `untouched: ${name}`);
  }

  const evidence = evidenceFor(
    outcome({
      stdout:
        "not ok 1 - a short secret is a signature anybody can forge\n  ---\n  error: 'secret_too_short was expected'\n  ...\n# tests 1\n# pass 0\n# fail 1\n",
    }),
  );
  assert.equal(evidence.failureSummary[0]?.test, 'a short secret is a signature anybody can forge');
  assert.match(evidence.failureSummary[0]?.assertion ?? '', /secret_too_short/);
});

test('a credential in the failing output is redacted, and the test name around it is not', () => {
  const evidence = evidenceFor(
    outcome({
      stdout:
        "not ok 1 - the pool survives a restart\n  ---\n  error: 'connect failed for postgres://ragers:hunter2@db:5432/x'\n  ...\n# tests 1\n# pass 0\n# fail 1\n",
      stderr: 'DATABASE_URL=postgres://ragers:hunter2@db:5432/x\n',
    }),
  );
  assert.equal(evidence.failureSummary[0]?.test, 'the pool survives a restart');
  assert.ok(!(evidence.evidenceExcerpt ?? '').includes('hunter2'), 'the excerpt carries no password');
  assert.match(evidence.evidenceExcerpt ?? '', /postgres:\/\/ragers:\[REDACTED\]@db/, 'but still names the dependency');
});

// ── Malformed input ───────────────────────────────────────────────────────
test('malformed runner output does not crash the evidence path', () => {
  const nasty: readonly string[] = [
    '',
    '\n\n\n',
    'not ok',
    'not ok 1 -',
    'not ok 1 - a test\n  ---\n  error: |-',
    'not ok 1 - a test\n  ---\n  error: |-\n',
    '# tests\n# pass\n# fail\n',
    `  binary-ish � [31m`,
    'ok 1 - passed but exit code says otherwise',
    'not ok 1 - '.repeat(500),
    '{"json":"instead of tap"}',
    'a'.repeat(200_000),
  ];
  for (const stdout of nasty) {
    const evidence = evidenceFor(outcome({ stdout }));
    assert.equal(typeof evidence.detail, 'string', `detail for ${JSON.stringify(stdout.slice(0, 24))}`);
    assert.ok(Array.isArray(evidence.failureSummary));
    assert.ok((evidence.evidenceExcerpt ?? '').length <= MAX_EXCERPT_CHARS + 32);
    assert.equal(typeof countsOf(stdout), 'object');
    assert.ok(Array.isArray(failuresOf(stdout)));
    assert.equal(typeof excerptOf(stdout), 'string');
  }
});

test('a process killed by a signal is reported as such rather than as exit code null', () => {
  const evidence = evidenceFor(outcome({ exitCode: null, stdout: 'the runner was killed' }));
  assert.equal(evidence.exitCode, null);
  assert.match(evidence.detail, /exited on a signal/);
});

// ── Passing gates stay concise ─────────────────────────────────────────────
test('a passing gate keeps counts and nothing else', () => {
  const evidence = evidenceFor(
    outcome({ exitCode: 0, stdout: 'TAP version 13\nok 1 - fine\n# tests 42\n# pass 42\n# fail 0\n' }),
  );
  assert.equal(evidence.detail, '42/42 assertions passed (1.2s)');
  assert.deepEqual(evidence.failureSummary, [], 'no failures');
  assert.equal(evidence.evidenceExcerpt, undefined, 'and no excerpt — a pass needs none');
  assert.equal(evidence.failuresOmitted, undefined);
});

test('a passing gate with no counts reports clean', () => {
  const evidence = evidenceFor(outcome({ exitCode: 0, stdout: 'static validation: PASS\n' }));
  assert.equal(evidence.detail, 'clean (1.2s)');
  assert.equal(evidence.evidenceExcerpt, undefined);
});

test('a browser suite reports its own counts', () => {
  const passing = evidenceFor(outcome({ exitCode: 0, stdout: '  29 passed (53.6s)\n' }));
  assert.equal(passing.detail, '29 browser test(s) passed (1.2s)');

  const failing = evidenceFor(
    outcome({
      exitCode: 1,
      stdout:
        '  1) tests/e2e/personas.spec.ts:12:3 › an operator sees why something ranks ─────\n\n    Error: expect(locator).toBeVisible() failed\n\n  1 failed\n  28 passed\n',
    }),
  );
  assert.equal(failing.counts.failed, 1);
  assert.match(failing.failureSummary[0]?.test ?? '', /an operator sees why something ranks/);
  assert.match(failing.failureSummary[0]?.assertion ?? '', /toBeVisible/);
});

// ── Blocked gates ─────────────────────────────────────────────────────────
test('a blocked gate keeps its blocker reason through the report and the ledger', () => {
  const blocked: GateResult = {
    id: 'deployment',
    name: 'Deployment to a target environment',
    requirement: 'deployment',
    status: 'blocked',
    durationMs: 0,
    detail: 'blocked by an external dependency',
    blockedBy: 'No deployment target is configured.',
    conclusion: 'BLOCKED',
  };
  const report = buildReport([blocked], '2026-09-10T00:00:00.000Z');
  assert.equal(report.results[0]?.blockedBy, 'No deployment target is configured.');
  assert.match(renderLedger(report), /No deployment target is configured\./);
  assert.equal(conclusionOf('blocked'), 'BLOCKED');
});

// ── Retries ───────────────────────────────────────────────────────────────
const gate = (
  status: GateResult['status'],
  detail: string,
  failures?: GateResult['failureSummary'],
): GateResult => ({
  id: 'orchestration_durability',
  name: 'Durable orchestration and restart recovery',
  requirement: 'durability',
  status,
  durationMs: 6_400,
  detail,
  exitCode: status === 'passed' ? 0 : 1,
  ...(failures === undefined ? {} : { failureSummary: failures }),
});

test('a fail then a pass is INITIAL_FAIL_RETRY_PASS, and the first attempt survives', () => {
  const first = gate('failed', '10/11 assertions passed, 1 failed — first failure: an abandoned lease is reclaimed', [
    { test: 'an abandoned lease is reclaimed and the job resumes on another worker', assertion: 'expected completed' },
  ]);
  const second = gate('passed', '11/11 assertions passed');

  const merged = mergeAttempt(first, second);
  assert.equal(merged.status, 'passed', 'the final state is the second attempt');
  assert.equal(merged.conclusion, 'INITIAL_FAIL_RETRY_PASS');
  assert.equal(merged.attempts?.length, 2);
  assert.equal(merged.attempts?.[0]?.status, 'failed');
  assert.equal(merged.attempts?.[0]?.attempt, 1);
  assert.match(
    merged.attempts?.[0]?.failureSummary?.[0]?.test ?? '',
    /an abandoned lease is reclaimed/,
    'the transient failure is still named',
  );
  assert.equal(merged.attempts?.[1]?.status, 'passed');

  // And the ledger says so out loud, even though the run is green.
  const ledger = renderLedger(buildReport([merged], '2026-09-10T00:00:00.000Z'));
  assert.match(ledger, /Gates that did not pass first time/);
  assert.match(ledger, /INITIAL_FAIL_RETRY_PASS/);
  assert.match(ledger, /an abandoned lease is reclaimed/);
});

test('a fail then another fail is INITIAL_FAIL_RETRY_FAIL', () => {
  const merged = mergeAttempt(gate('failed', 'first'), gate('failed', 'second'));
  assert.equal(merged.conclusion, 'INITIAL_FAIL_RETRY_FAIL');
  assert.equal(merged.status, 'failed');
});

test('a pass that stays a pass across attempts is a plain PASS, with no transient section', () => {
  const merged = mergeAttempt(gate('passed', 'first'), gate('passed', 'second'));
  assert.equal(merged.conclusion, 'PASS');
  const ledger = renderLedger(buildReport([merged], '2026-09-10T00:00:00.000Z'));
  assert.ok(!/Gates that did not pass first time/.test(ledger), 'nothing transient to report');
});

test('a third attempt appends rather than replacing the history', () => {
  const twice = mergeAttempt(gate('failed', 'first'), gate('failed', 'second'));
  const thrice = mergeAttempt(twice, gate('passed', 'third'));
  assert.equal(thrice.attempts?.length, 3);
  assert.deepEqual(
    thrice.attempts?.map((attempt) => attempt.attempt),
    [1, 2, 3],
  );
  assert.equal(thrice.conclusion, 'INITIAL_FAIL_RETRY_PASS', 'it still failed the first time');
});

test('a retried gate that ends blocked is BLOCKED, not a retry outcome', () => {
  const merged = mergeAttempt(gate('failed', 'first'), {
    ...gate('failed', 'blocked now'),
    status: 'blocked',
    blockedBy: 'the database went away',
  });
  assert.equal(merged.conclusion, 'BLOCKED');
});

// ── Status calculation is unchanged ───────────────────────────────────────
test('the evidence fields do not change any readiness status', () => {
  // The whole slice is additive. A gate carrying failure summaries, excerpts and an
  // attempt history must decide exactly what the same gate decided without them.
  const bare: GateResult = {
    id: 'x',
    name: 'X',
    scope: 'experience_loop',
    requirement: 'r',
    status: 'passed',
    durationMs: 1,
    detail: 'clean',
  };
  const dressed: GateResult = {
    ...bare,
    command: 'node --test x',
    exitCode: 0,
    counts: { tests: 1, passed: 1, failed: 0 },
    conclusion: 'PASS',
  };
  assert.equal(decideStatus([bare]), decideStatus([dressed]));
  assert.equal(decideExperienceLoopStatus([bare]), decideExperienceLoopStatus([dressed]));

  // And a gate whose *final* state is a pass counts as a pass even when its history
  // records a failure. Certification policy is unchanged by this slice; the evidence
  // is what changed.
  const retried = mergeAttempt({ ...dressed, status: 'failed' }, dressed);
  assert.equal(retried.conclusion, 'INITIAL_FAIL_RETRY_PASS');
  assert.equal(decideStatus([retried]), decideStatus([dressed]));
  assert.equal(buildReport([retried], 'now').totals.passed, 1);
  assert.equal(buildReport([retried], 'now').totals.failed, 0);
});

test('the report totals still count final states, and a failure is still a failure', () => {
  const passed: GateResult = { id: 'a', name: 'A', requirement: 'r', status: 'passed', durationMs: 1, detail: 'ok' };
  const failed: GateResult = { id: 'b', name: 'B', requirement: 'r', status: 'failed', durationMs: 1, detail: 'no' };
  const blocked: GateResult = {
    id: 'c',
    name: 'C',
    requirement: 'r',
    status: 'blocked',
    durationMs: 0,
    detail: 'blocked',
    blockedBy: 'absent',
  };
  const report = buildReport([passed, failed, blocked], 'now');
  assert.deepEqual(report.totals, { passed: 1, failed: 1, blocked: 1 });
  assert.equal(report.status, 'RAGERS_ENGINE_E2E_NO_GO');
});
