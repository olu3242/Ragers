import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  decideStatus,
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
