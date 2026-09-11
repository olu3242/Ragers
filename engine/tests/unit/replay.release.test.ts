import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPLAY_CLASSES,
  REPLAY_INVARIANTS,
  REPLAY_RULES,
  idempotencyKeyIsGenerated,
  mayBeRegistered,
  replayReDecides,
} from '../../src/domain/replay.ts';
import {
  CONTROLLED_VALIDATION_REQUIRES,
  PRODUCTION_PILOT_REQUIRES,
  RELEASE_DIMENSIONS,
  codeReadinessAbsorbsAnExternalBlocker,
  decide,
  readDimensions,
  readinessCanBeAsserted,
  releaseStatus,
  type DimensionReading,
  type ReleaseDimension,
} from '../../src/certification/release.ts';
import type { GateResult } from '../../src/certification/harness.ts';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Phases 96 and 99 as rules.
 *
 * Phase 96's rule is `replay != re-decide`, and the interesting half is that a violation would be
 * *invisible*: the system would work and would quietly do a thing twice under load or after a
 * restart. So the assertions here are structural — over the source, over the class table — rather
 * than behavioural, and the behavioural half is in the integration and live suites.
 *
 * Phase 99's rule is that a release status cannot claim more than its weakest required dimension.
 * The tests build readings by hand, because the point is the *decision function*, and feeding it
 * real gates would test the gates.
 */

// ── Phase 96: replay ─────────────────────────────────────────────────────
test('every replay class states its mechanism, and only one is unsafe', () => {
  for (const replayClass of REPLAY_CLASSES) {
    const rule = REPLAY_RULES[replayClass];
    assert.ok(rule.summary.length > 0, `${replayClass} says what it does`);
    // "The handler is careful" is not a mechanism. Each safe class names a *structural* reason.
    assert.ok(rule.mechanism.length > 30, `${replayClass} names its mechanism`);
  }
  assert.equal(
    REPLAY_CLASSES.filter((replayClass) => !REPLAY_RULES[replayClass].safeToReplay).length,
    1,
    'exactly one class is unsafe, and it is the one no handler may be in',
  );
  assert.equal(mayBeRegistered('forbidden_redecide'), false);
  assert.equal(mayBeRegistered('recompute'), true);
  assert.equal(mayBeRegistered('idempotent_write'), true);
  assert.equal(mayBeRegistered('derived_dispatch'), true);
  assert.equal(replayReDecides(), false);
});

test('no consumer generates an idempotency key', () => {
  // **The single most effective way to break every replay guarantee.** A generated key makes each
  // replay look like a new intent to the bus, so an at-least-once pipeline becomes duplicated
  // effects — and nothing about that is visible in a green suite.
  //
  // Swept over source rather than trusted: every `idempotencyKey` in a consumer must be derived
  // from the event or the run, never from `ids.next(` or `Math.random` or a clock reading.
  const engines = join(engineRoot, 'src', 'engines');
  const offenders: string[] = [];

  for (const name of readdirSync(engines).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(join(engines, name), 'utf8');
    // Each dispatch's key, as written. A key is suspect when it mentions an id factory, a random
    // source, or a clock — all three make the same key unreproducible on a second delivery.
    for (const match of source.matchAll(/idempotencyKey:\s*([^,\n]+)/g)) {
      const key = match[1] ?? '';
      if (/ids\.next|Math\.random|Date\.now|clock\.now|randomUUID/.test(key)) {
        offenders.push(`${name}: ${key.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'every consumer derives its idempotency key');
  assert.equal(idempotencyKeyIsGenerated(), false);
});

test('the replay invariants are named, so each can be asserted rather than assumed', () => {
  assert.ok(REPLAY_INVARIANTS.length >= 6);
  for (const invariant of REPLAY_INVARIANTS) {
    assert.match(invariant, /does not/, 'each names something that must not happen');
  }
});

// ── Phase 99: the release contract ───────────────────────────────────────
const gate = (
  overrides: Partial<GateResult> & Pick<GateResult, 'requirement' | 'status'>,
): GateResult => ({
  id: overrides.id ?? 'g',
  name: overrides.name ?? 'a gate',
  requirement: overrides.requirement,
  status: overrides.status,
  durationMs: 1,
  detail: overrides.detail ?? '',
  ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
  ...(overrides.blockedBy === undefined ? {} : { blockedBy: overrides.blockedBy }),
});

const reading = (dimension: ReleaseDimension, value: DimensionReading['value']): DimensionReading => ({
  dimension,
  value,
  evidence: 'built by hand for this test',
});

test('a dimension with no evidence is BLOCKED, never READY', () => {
  // The honest default. A dimension nothing has checked must not read as satisfied, and the
  // distinction from NOT_READY is the whole point: `BLOCKED` means we could not look.
  const readings = readDimensions({
    results: [],
    objectStorageReady: false,
    benchmarkDataReady: false,
    liveProvidersReady: false,
  });
  for (const value of readings) {
    assert.equal(value.value, 'BLOCKED', `${value.dimension} with no gates is blocked`);
    assert.ok(value.missing, 'and says what is missing');
  }
});

test('a failed gate is NOT_READY and a blocked gate is BLOCKED, and they are different', () => {
  const failed = readDimensions({
    results: [gate({ requirement: 'browser E2E', status: 'failed', name: 'Browser E2E' })],
    objectStorageReady: true,
    benchmarkDataReady: true,
    liveProvidersReady: true,
  });
  assert.equal(failed.find((value) => value.dimension === 'BROWSER_READY')?.value, 'NOT_READY');

  const blocked = readDimensions({
    results: [gate({ requirement: 'deployment', status: 'blocked', blockedBy: 'no target configured' })],
    objectStorageReady: true,
    benchmarkDataReady: true,
    liveProvidersReady: true,
  });
  const deployment = blocked.find((value) => value.dimension === 'DEPLOYMENT_READY');
  assert.equal(deployment?.value, 'BLOCKED');
  assert.match(deployment?.missing ?? '', /no target configured/, 'and it names the dependency');
});

test('data and provider readiness come from the environment, not from a gate', () => {
  // A gate that passed against a fake would be asserting the opposite of what these dimensions
  // ask. So no gate can make them READY.
  const withEveryGatePassing = readDimensions({
    results: RELEASE_DIMENSIONS.map((dimension) =>
      gate({ requirement: dimension.toLowerCase(), status: 'passed' }),
    ),
    objectStorageReady: false,
    benchmarkDataReady: false,
    liveProvidersReady: false,
  });
  assert.equal(withEveryGatePassing.find((value) => value.dimension === 'DATA_READY')?.value, 'BLOCKED');
  assert.equal(withEveryGatePassing.find((value) => value.dimension === 'PROVIDER_READY')?.value, 'BLOCKED');

  const provided = readDimensions({
    results: [],
    objectStorageReady: true,
    benchmarkDataReady: true,
    liveProvidersReady: true,
  });
  assert.equal(provided.find((value) => value.dimension === 'DATA_READY')?.value, 'READY');
  assert.equal(provided.find((value) => value.dimension === 'PROVIDER_READY')?.value, 'READY');
});

test('a release cannot be GO while a required dimension is not satisfied', () => {
  // **The rule the phase is.** And there is no override parameter, which is the other half:
  // a function with `force` would be called with `force` by somebody under pressure.
  const readings = [
    reading('CODE_READY', 'READY'),
    reading('SECURITY_READY', 'READY'),
    reading('BROWSER_READY', 'NOT_READY'),
    reading('OPERATIONS_READY', 'READY'),
  ];
  const verdict = decide(readings, CONTROLLED_VALIDATION_REQUIRES);
  assert.equal(verdict.decision, 'NO_GO');
  assert.deepEqual(verdict.blocking, ['BROWSER_READY']);
  assert.match(verdict.reason, /BROWSER_READY=NOT_READY/);
});

test('a missing external blocker cannot make code readiness anything it is not', () => {
  const readings = readDimensions({
    results: [
      gate({ requirement: 'unit', status: 'passed', scope: 'engine' }),
      gate({ requirement: 'deployment', status: 'blocked', blockedBy: 'no target' }),
      gate({ requirement: 'rollback', status: 'blocked', blockedBy: 'needs a deployment' }),
    ],
    objectStorageReady: true,
    benchmarkDataReady: false,
    liveProvidersReady: false,
  });
  assert.equal(readings.find((value) => value.dimension === 'CODE_READY')?.value, 'READY');
  assert.equal(readings.find((value) => value.dimension === 'DEPLOYMENT_READY')?.value, 'BLOCKED');
  assert.equal(codeReadinessAbsorbsAnExternalBlocker(), false);

  // And the aggregate cannot claim more than the weakest required dimension.
  const pilot = decide(readings, PRODUCTION_PILOT_REQUIRES);
  assert.equal(pilot.decision, 'NO_GO');
  assert.ok(pilot.blocking.includes('DEPLOYMENT_READY'));
  assert.ok(pilot.blocking.includes('ROLLBACK_READY'));
});

test('controlled validation may be GO while a production pilot is NO_GO', () => {
  // The honest position for this codebase: the internal dimensions are certified and the external
  // ones are blocked on things no amount of code produces.
  const readings = [
    reading('CODE_READY', 'READY'),
    reading('SECURITY_READY', 'READY'),
    reading('BROWSER_READY', 'READY'),
    reading('OPERATIONS_READY', 'READY_WITH_CONDITIONS'),
    reading('DATA_READY', 'BLOCKED'),
    reading('PROVIDER_READY', 'BLOCKED'),
    reading('DEPLOYMENT_READY', 'BLOCKED'),
    reading('ROLLBACK_READY', 'BLOCKED'),
  ];
  const controlled = decide(readings, CONTROLLED_VALIDATION_REQUIRES);
  const pilot = decide(readings, PRODUCTION_PILOT_REQUIRES);
  assert.equal(controlled.decision, 'GO');
  assert.equal(pilot.decision, 'NO_GO');
  assert.equal(releaseStatus(controlled, pilot), 'RAGERS_RC2_READY_WITH_EXTERNAL_BLOCKERS');
});

test('a failing internal dimension makes the whole release NO_GO', () => {
  const readings = [
    reading('CODE_READY', 'NOT_READY'),
    reading('SECURITY_READY', 'READY'),
    reading('BROWSER_READY', 'READY'),
    reading('OPERATIONS_READY', 'READY'),
  ];
  const controlled = decide(readings, CONTROLLED_VALIDATION_REQUIRES);
  assert.equal(releaseStatus(controlled, decide(readings, PRODUCTION_PILOT_REQUIRES)), 'RAGERS_RC2_NO_GO');
});

test('a production pilot requires all eight, and nothing can be asserted by hand', () => {
  assert.equal(PRODUCTION_PILOT_REQUIRES.length, 8);
  assert.deepEqual([...PRODUCTION_PILOT_REQUIRES].sort(), [...RELEASE_DIMENSIONS].sort());
  // A pilot puts real people's accounts of real things into a system. There is no subset of these
  // that makes one responsible.
  for (const dimension of RELEASE_DIMENSIONS) {
    assert.ok(PRODUCTION_PILOT_REQUIRES.includes(dimension));
  }
  assert.equal(readinessCanBeAsserted(), false);
  // No status value could be mistaken for production readiness. RC2 is not that.
  const statuses = [
    'RAGERS_RC2_READY_FOR_CONTROLLED_VALIDATION',
    'RAGERS_RC2_READY_WITH_EXTERNAL_BLOCKERS',
    'RAGERS_RC2_NO_GO',
  ];
  for (const status of statuses) {
    assert.equal(/production.?ready/i.test(status), false, `${status} does not claim production`);
  }
});
