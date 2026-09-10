import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPENDENCY_CONSEQUENCES,
  degradedModeAcceptsACommand,
  degradedModeChangesARefusal,
  degradedStateFrom,
  degradedSummary,
  UNMAPPED_CONSEQUENCES,
} from '../../src/domain/degraded.ts';
import type { HealthReport, HealthState } from '../../src/runtime/health.ts';

/**
 * Phase 67.
 *
 * Every case here is built from a fabricated health report rather than by breaking a real
 * dependency, which is the point of the module being pure: the state that has to be right
 * is the one nobody can conveniently reproduce.
 */
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');

/** Tolerates a directory that does not exist, so the guard cannot fail for the wrong reason. */
const readdirSyncSafe = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const report = (
  dependencies: readonly { name: string; state: HealthState; detail?: string }[],
): HealthReport => ({
  state: dependencies.some((d) => d.state === 'unhealthy')
    ? 'unhealthy'
    : dependencies.some((d) => d.state === 'degraded')
      ? 'degraded'
      : 'healthy',
  dependencies: dependencies.map((d) => ({ ...d, checkedAt: '2026-09-10T00:00:00.000Z' })),
  checkedAt: '2026-09-10T00:00:00.000Z',
});

test('a healthy system is nominal and lists nothing', () => {
  // A report that named every healthy dependency as "affected" would bury the one that
  // matters on the day one is.
  const state = degradedStateFrom(report([{ name: 'database', state: 'healthy' }]));
  assert.equal(state.level, 'nominal');
  assert.deepEqual(state.affected, []);
  assert.deepEqual(state.refusing, []);
  assert.equal(degradedSummary(state), '', 'and prints nothing');
});

test('an unreachable database is impaired, and says writes are being refused', () => {
  const state = degradedStateFrom(
    report([
      { name: 'database', state: 'unhealthy', detail: 'connection refused' },
      { name: 'outbox', state: 'healthy' },
    ]),
  );
  assert.equal(state.level, 'impaired');
  assert.equal(state.affected.length, 1, 'the healthy dependency is not listed');
  assert.equal(state.affected[0]?.detail, 'connection refused', 'and the cause travels with it');
  assert.ok(
    state.refusing.some((line) => /write/i.test(line)),
    'the consequence is stated in the terms a user would describe',
  );
});

test('a backed-up outbox is degraded, not impaired, because nothing is refused', () => {
  // The distinction an operator most needs: "some things are behind" and "requests are
  // failing" call for completely different responses, and a boolean would lose it.
  const state = degradedStateFrom(report([{ name: 'outbox', state: 'degraded', detail: '4000 pending' }]));
  assert.equal(state.level, 'degraded');
  // The list of refusals is empty, because nothing is being refused — and the summary is
  // where that fact reads as an answer rather than as an item in a list of outages.
  assert.deepEqual(state.refusing, [], 'nothing is being refused, so nothing is listed');
  assert.match(state.affected[0]?.consequences.summary ?? '', /Nothing is refused/);
  assert.ok(
    state.affected[0]?.consequences.unaffected.some((line) => /catches up/.test(line)),
    'with what recovers on its own',
  );
});

test('one unhealthy dependency makes the whole state impaired even beside a degraded one', () => {
  const state = degradedStateFrom(
    report([
      { name: 'outbox', state: 'degraded' },
      { name: 'database', state: 'unhealthy' },
    ]),
  );
  assert.equal(state.level, 'impaired', 'the worst state wins');
  assert.equal(state.affected.length, 2, 'and both are still listed');
});

test('two dependencies with one shared consequence read as one thing being refused', () => {
  // Deduplicated so the list is a list of *effects*, not of causes: an operator wants to
  // know what users are seeing, and seeing the same line twice tells them nothing extra.
  const state = degradedStateFrom(
    report([
      { name: 'unmapped_one', state: 'unhealthy' },
      { name: 'unmapped_two', state: 'unhealthy' },
    ]),
  );
  assert.equal(state.affected.length, 2, 'both causes are listed');
  assert.equal(state.refusing.length, 1, 'and their shared effect once');
});

test('a degraded system refuses nothing, and a report of two backlogs still says so', () => {
  // The case the first version of this got wrong: `refusing` carried the string "Nothing
  // is refused", so a list named for refusals had entries in it while nothing was refused.
  const state = degradedStateFrom(
    report([
      { name: 'dead_letters', state: 'degraded' },
      { name: 'outbox', state: 'degraded' },
    ]),
  );
  assert.equal(state.level, 'degraded');
  assert.deepEqual(state.refusing, [], 'a backlog is not a refusal');
  for (const dependency of state.affected) {
    assert.ok(dependency.consequences.summary.length > 0, `${dependency.name} still explains itself`);
  }
});

test('every dependency the engine registers a health check for has stated consequences', () => {
  // The discovery guard, in the Phase 48 pattern: enumerated from the composition root
  // rather than from a list somebody maintains here. A dependency added later without
  // consequences fails this test rather than silently reporting "nothing is refused".
  const source = readFileSync(join(engineRoot, 'src', 'engine.ts'), 'utf8');
  const registered = [...source.matchAll(/health\.register\(\{\s*\n?\s*name:\s*'([a-z_]+)'/g)].map(
    (match) => match[1] as string,
  );
  assert.ok(registered.length >= 3, `found the registrations (${registered.join(', ')})`);
  for (const name of registered) {
    assert.ok(
      DEPENDENCY_CONSEQUENCES[name] !== undefined,
      `${name} is registered as a health check but nobody stated what it breaks`,
    );
  }
});

test('an unmapped dependency reads as a gap rather than as reassurance', () => {
  // The worst answer during an incident is a confident wrong one. A health check with no
  // stated consequences must not report "nothing is refused".
  const state = degradedStateFrom(report([{ name: 'a_dependency_nobody_mapped', state: 'unhealthy' }]));
  assert.deepEqual(state.affected[0]?.consequences, UNMAPPED_CONSEQUENCES);
  assert.match(state.refusing[0] ?? '', /Unknown/);
  assert.match(state.refusing[0] ?? '', /unbounded/);
});

test('every stated consequence names both what breaks and what does not', () => {
  // Naming what still works is the half people forget, and it is what keeps an incident
  // response proportionate instead of taking the whole product down in sympathy.
  for (const [name, consequences] of Object.entries(DEPENDENCY_CONSEQUENCES)) {
    // `refuses` may be empty — that is the honest value for a backlog. The summary may
    // not be, because it is the one line somebody reads first.
    assert.ok(consequences.summary.length > 20, `${name} has a summary worth reading`);
    assert.ok(consequences.unaffected.length > 0, `${name} says what still works`);
  }
});

test('degraded mode is derived: no command sets it, and it changes no refusal', () => {
  // A stored flag needs somebody to set it, which means somebody to forget to clear it —
  // and a system reporting degraded a week after it recovered is a system nobody believes.
  assert.equal(degradedModeAcceptsACommand(), false);
  assert.equal(degradedModeChangesARefusal(), false);
});

test('nothing that decides an outcome imports the degraded module', () => {
  // This is a lens, not a gate. If an engine read it, an unavailable dependency would
  // start causing refusals *in addition to* the ones it already causes, and a bug here
  // would become an outage. Enforced by discovery over the directories that decide.
  const roots = ['src/domain', 'src/engines'];
  const offenders: string[] = [];
  for (const root of roots) {
    const dir = join(engineRoot, root);
    for (const name of readdirSyncSafe(dir)) {
      if (!name.endsWith('.ts') || name === 'degraded.ts') continue;
      const source = readFileSync(join(dir, name), 'utf8');
      if (/from '\.\.?\/(domain\/)?degraded\.ts'/.test(source)) offenders.push(`${root}/${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'a decision that reads the degraded state is a refusal this phase caused');
});
