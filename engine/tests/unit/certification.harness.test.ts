import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  decideStatus,
  decideExperienceSignalEngineStatus,
  decideGovernanceActionStatus,
  decideExperienceOsStatus,
  GATES,
  renderLedger,
  type GateResult,
} from '../../src/certification/harness.ts';

const result = (id: string, status: GateResult['status']): GateResult => ({
  id,
  name: `Gate ${id}`,
  requirement: id,
  status,
  durationMs: 1,
  detail: 'detail',
  ...(status === 'blocked' ? { blockedBy: 'no live database' } : {}),
});

test('every required gate from the roadmap is represented', () => {
  const required = [
    'schema/migrations',
    'unit',
    'integration',
    'authorization',
    'retry/dead-letter',
    'browser E2E',
    'voice',
    'moderation failure-path',
    'privacy/search leakage',
    'concurrency',
    'accessibility',
    'build',
    'deployment',
    'backup/restore',
    'rollback',
  ];
  const covered = new Set(GATES.map((gate) => gate.requirement));
  for (const requirement of required) {
    assert.ok(covered.has(requirement), `no gate covers "${requirement}"`);
  }
});

test('every gate is either runnable or explicitly blocked, never neither', () => {
  for (const gate of GATES) {
    const runnable = gate.command !== undefined;
    const blocked = gate.blockedBy !== undefined;
    assert.notEqual(runnable, blocked, `${gate.id} must be exactly one of runnable or blocked`);
    if (blocked) {
      assert.ok((gate.blockedBy ?? '').length > 20, `${gate.id} must say specifically what is missing`);
    }
  }
});

test('a failing gate produces NO_GO, whatever else passed', () => {
  assert.equal(decideStatus([result('a', 'passed'), result('b', 'failed')]), 'RAGERS_ENGINE_E2E_NO_GO');
  assert.equal(
    decideStatus([result('a', 'passed'), result('b', 'blocked'), result('c', 'failed')]),
    'RAGERS_ENGINE_E2E_NO_GO',
    'a failure outranks a blocker',
  );
});

test('a blocked gate can never produce a plain READY', () => {
  assert.equal(
    decideStatus([result('a', 'passed'), result('b', 'blocked')]),
    'RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS',
  );
});

test('READY requires every gate green and none blocked', () => {
  assert.equal(decideStatus([result('a', 'passed'), result('b', 'passed')]), 'RAGERS_ENGINE_E2E_READY');
});

test('an empty run is not a pass', () => {
  assert.equal(decideStatus([]), 'RAGERS_ENGINE_E2E_NO_GO', 'running nothing must not certify anything');
});

test('the status is one of exactly three values', () => {
  const permitted = new Set([
    'RAGERS_ENGINE_E2E_READY',
    'RAGERS_ENGINE_E2E_READY_WITH_EXTERNAL_BLOCKERS',
    'RAGERS_ENGINE_E2E_NO_GO',
  ]);
  for (const combination of [
    [result('a', 'passed')],
    [result('a', 'blocked')],
    [result('a', 'failed')],
    [],
  ]) {
    assert.ok(permitted.has(decideStatus(combination)));
  }
});

test('the ledger names every blocker and every failure', () => {
  const report = buildReport(
    [result('a', 'passed'), result('b', 'blocked'), result('c', 'failed')],
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(report.totals.passed, 1);
  assert.equal(report.totals.blocked, 1);
  assert.equal(report.totals.failed, 1);

  const ledger = renderLedger(report);
  assert.match(ledger, /## Certification status: `RAGERS_ENGINE_E2E_NO_GO`/);
  assert.match(ledger, /## External blockers/);
  assert.match(ledger, /no live database/);
  assert.match(ledger, /## Failing gates/);
  assert.match(ledger, /Gate c/);
});

test('a clean ledger omits the blocker and failure sections', () => {
  const ledger = renderLedger(buildReport([result('a', 'passed')], '2026-01-01T00:00:00.000Z'));
  assert.match(ledger, /RAGERS_ENGINE_E2E_READY/);
  assert.equal(ledger.includes('## External blockers'), false);
  assert.equal(ledger.includes('## Failing gates'), false);
});

// ── The Experience Signal Engine's own status ────────────────────────────
test('the ESE status is decided over ESE gates only', () => {
  const gate = (
    id: string,
    status: 'passed' | 'failed' | 'blocked',
    scope?: 'experience_signal_engine',
  ) => ({
    id,
    name: id,
    requirement: 'ese/contract',
    status,
    durationMs: 1,
    detail: '',
    ...(scope === undefined ? {} : { scope }),
  });

  // A platform blocker must not hold the contract's status down, and a contract
  // failure must not be hidden by a green platform.
  assert.equal(
    decideExperienceSignalEngineStatus([
      gate('deployment', 'blocked'),
      gate('ese_contract', 'passed', 'experience_signal_engine'),
    ]),
    'EXPERIENCE_SIGNAL_ENGINE_READY',
    'a missing deployment target says nothing about whether corroboration holds',
  );

  assert.equal(
    decideExperienceSignalEngineStatus([
      gate('static', 'passed'),
      gate('ese_contract', 'failed', 'experience_signal_engine'),
    ]),
    'EXPERIENCE_SIGNAL_ENGINE_NOT_READY',
  );

  assert.equal(
    decideExperienceSignalEngineStatus([
      gate('ese_contract', 'passed', 'experience_signal_engine'),
      gate('ese_live', 'blocked', 'experience_signal_engine'),
    ]),
    'EXPERIENCE_SIGNAL_ENGINE_READY_WITH_BLOCKERS',
  );

  assert.equal(
    decideExperienceSignalEngineStatus([gate('static', 'passed')]),
    'EXPERIENCE_SIGNAL_ENGINE_NOT_READY',
    'no ESE gates ran, so nothing was certified',
  );
});

test('every ESE gate names a command or a blocker, and none is silently skipped', () => {
  const own = GATES.filter((gate) => gate.scope === 'experience_signal_engine');
  assert.ok(own.length >= 12, 'the contract is certified by more than a couple of gates');
  for (const gate of own) {
    assert.ok(
      gate.command !== undefined || gate.blockedBy !== undefined,
      `${gate.id} must either run or say why it cannot`,
    );
    if (gate.requiresEnv !== undefined) {
      assert.ok(gate.blockedWithoutEnv, `${gate.id} must say what is missing when ${gate.requiresEnv} is unset`);
    }
  }
});

test('the ledger reports both statuses', () => {
  const ledger = renderLedger(
    buildReport(
      [
        {
          id: 'ese_contract',
          name: 'ESE contract',
          scope: 'experience_signal_engine',
          requirement: 'ese/contract',
          status: 'passed',
          durationMs: 1,
          detail: 'ok',
        },
      ],
      '2026-01-01T00:00:00.000Z',
    ),
  );
  assert.match(ledger, /Certification status: `RAGERS_ENGINE_E2E_READY`/);
  assert.match(ledger, /Experience Signal Engine status: `EXPERIENCE_SIGNAL_ENGINE_READY`/);
  assert.match(ledger, /a response is never a resolution/, 'and says what the second status means');
});

test('the Phases 31–40 band has its own status, and its own gates to earn it', () => {
  const band = GATES.filter((gate) => gate.scope === 'governance_action');
  assert.ok(band.length >= 5, 'the band is certified by its own gates, not by the engine gates');

  // The band covers every layer: domain, the bus, a live database, and a browser.
  const requirements = band.map((gate) => gate.requirement);
  assert.ok(requirements.some((r) => r.includes('31-35')));
  assert.ok(requirements.some((r) => r.includes('38-40')));
  assert.ok(requirements.some((r) => r === 'phases/31-40'));
  assert.ok(requirements.some((r) => r.endsWith('/live')));
  assert.ok(requirements.some((r) => r.endsWith('/surfaces')));
});

test('a band status is decided by the band’s own gates and nothing else', () => {
  const passing = [
    { id: 'a', name: 'a', scope: 'governance_action' as const, requirement: 'r', status: 'passed' as const, durationMs: 1, detail: '' },
  ];
  assert.equal(decideGovernanceActionStatus(passing), 'PHASES_31_40_READY');

  // An engine gate failing does not make the band not-ready, and vice versa: rolling
  // them together would hide which of the two is actually broken.
  assert.equal(
    decideGovernanceActionStatus([
      ...passing,
      { id: 'b', name: 'b', requirement: 'r', status: 'failed' as const, durationMs: 1, detail: '' },
    ]),
    'PHASES_31_40_READY',
  );
  assert.equal(
    decideGovernanceActionStatus([
      ...passing,
      { id: 'c', name: 'c', scope: 'governance_action' as const, requirement: 'r', status: 'blocked' as const, durationMs: 1, detail: '' },
    ]),
    'PHASES_31_40_READY_WITH_EXTERNAL_BLOCKERS',
  );
  // No gates at all is not ready. An empty band cannot certify itself.
  assert.equal(decideGovernanceActionStatus([]), 'PHASES_31_40_NOT_READY');
});

test('the Experience OS band has its own gates, covering every layer', () => {
  const band = GATES.filter((gate) => gate.scope === 'experience_os');
  assert.ok(band.length >= 5, 'the band is certified by its own gates');
  const requirements = band.map((gate) => gate.requirement);
  assert.ok(requirements.some((r) => r.includes('41-43')));
  assert.ok(requirements.some((r) => r.includes('44-47')));
  assert.ok(requirements.some((r) => r.includes('48-49')));
  assert.ok(requirements.some((r) => r === 'phases/41-50'));
  assert.ok(requirements.some((r) => r.endsWith('/live')));
});

test('data-blocked is a distinct status from ready and from not-ready', () => {
  const passing = [
    {
      id: 'a',
      name: 'a',
      scope: 'experience_os' as const,
      requirement: 'r',
      status: 'passed' as const,
      durationMs: 1,
      detail: '',
    },
  ];
  // Every gate passes and the sample is absent: the code is certified and the benchmark is
  // empty. Reporting READY would claim a benchmark nobody could produce; reporting NOT_READY
  // would be wrong about which thing is missing.
  assert.equal(decideExperienceOsStatus(passing, true), 'RAGERS_EXPERIENCE_OS_CODE_READY_DATA_BLOCKED');
  assert.equal(decideExperienceOsStatus(passing, false), 'RAGERS_EXPERIENCE_OS_READY');
  assert.equal(
    decideExperienceOsStatus(
      [...passing, { id: 'b', name: 'b', scope: 'experience_os' as const, requirement: 'r', status: 'failed' as const, durationMs: 1, detail: '' }],
      false,
    ),
    'RAGERS_EXPERIENCE_OS_NOT_READY',
  );
  // A failing gate outranks a data gap: broken code is not "data-blocked".
  assert.equal(
    decideExperienceOsStatus(
      [...passing, { id: 'c', name: 'c', scope: 'experience_os' as const, requirement: 'r', status: 'failed' as const, durationMs: 1, detail: '' }],
      true,
    ),
    'RAGERS_EXPERIENCE_OS_NOT_READY',
  );
  assert.equal(decideExperienceOsStatus([], true), 'RAGERS_EXPERIENCE_OS_NOT_READY');
});
