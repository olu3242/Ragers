import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideQuota,
  QUOTA_CLASSES,
  QUOTA_CLASS_BY_COMMAND,
  QUOTA_LIMITS,
  quotaClassOf,
  quotaSignalsForTrust,
  quotaWindowKey,
  setQuotaForActor,
  throttleMessage,
  UNTHROTTLED_COMMANDS,
  type QuotaWindow,
} from '../../src/domain/quota.ts';
import { INTEGRITY_SCAN_ROOTS } from '../../src/domain/entitlement.ts';

/**
 * Phase 61 — request governance.
 *
 * `rate_limited` has been in the error taxonomy since the runtime was written, has been
 * one of the two retryable kinds, and has been mapped to HTTP 429 by the API layer —
 * and until this phase nothing produced it. So these tests are as much about the
 * contract that was already decided as about the counting that now honours it.
 */
const NOW = 1_800_000_000_000;
const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(here, '..', '..');

const window = (count: number, startedAt = NOW): QuotaWindow => ({
  id: quotaWindowKey('actor_1', 'interaction'),
  actorId: 'actor_1',
  quotaClass: 'interaction',
  windowStartedAt: startedAt,
  count,
});

// ── The window ────────────────────────────────────────────────────────────
test('a first request opens a window at one', () => {
  const decision = decideQuota('interaction', undefined, 'actor_1', NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.window.count, 1);
  assert.equal(decision.allowed && decision.window.windowStartedAt, NOW);
  assert.equal(decision.allowed && decision.remaining, QUOTA_LIMITS.interaction.limit - 1);
});

test('the request that reaches the limit is allowed and the next one is not', () => {
  const limit = QUOTA_LIMITS.interaction.limit;
  const atLimit = decideQuota('interaction', window(limit - 1), 'actor_1', NOW);
  assert.equal(atLimit.allowed, true, 'the limit-th request is the last allowed one');
  assert.equal(atLimit.allowed && atLimit.remaining, 0);

  const over = decideQuota('interaction', window(limit), 'actor_1', NOW);
  assert.equal(over.allowed, false);
  assert.equal(over.allowed === false && over.limit, limit);
});

test('a refusal says when to come back, because a 429 without one is retried in a loop', () => {
  const policy = QUOTA_LIMITS.interaction;
  const halfway = decideQuota('interaction', window(policy.limit, NOW), 'actor_1', NOW + policy.windowMs / 2);
  assert.equal(halfway.allowed, false);
  assert.equal(halfway.allowed === false && halfway.retryAfterMs, policy.windowMs / 2);
});

test('the window rolls over, and the count starts again rather than drifting', () => {
  const policy = QUOTA_LIMITS.interaction;
  const after = decideQuota('interaction', window(policy.limit, NOW), 'actor_1', NOW + policy.windowMs);
  assert.equal(after.allowed, true, 'the window expired');
  assert.equal(after.allowed && after.window.count, 1, 'counted from one, not from the old total');
  assert.equal(after.allowed && after.window.windowStartedAt, NOW + policy.windowMs, 'and the window moved');
});

test('a window that expired long ago starts from now, not from a multiple of the window', () => {
  const policy = QUOTA_LIMITS.interaction;
  const later = NOW + policy.windowMs * 40;
  const decision = decideQuota('interaction', window(policy.limit, NOW), 'actor_1', later);
  assert.equal(decision.allowed && decision.window.windowStartedAt, later);
});

test('the key is per actor and per class, so one class cannot exhaust another', () => {
  assert.notEqual(quotaWindowKey('actor_1', 'authoring'), quotaWindowKey('actor_1', 'interaction'));
  assert.notEqual(quotaWindowKey('actor_1', 'authoring'), quotaWindowKey('actor_2', 'authoring'));
});

test('every class has a limit and a window, and none of them is zero', () => {
  for (const quotaClass of QUOTA_CLASSES) {
    const policy = QUOTA_LIMITS[quotaClass];
    assert.ok(policy.limit > 0, `${quotaClass} has a limit`);
    assert.ok(policy.windowMs > 0, `${quotaClass} has a window`);
  }
});

// ── Classification ────────────────────────────────────────────────────────
test('reporting harm is never throttled', () => {
  // The one that matters most. Somebody being harassed at speed needs to report at
  // speed, and an attacker gains nothing from filing a report.
  assert.equal(quotaClassOf('safety.fileReport'), undefined);
  assert.ok('safety.fileReport' in UNTHROTTLED_COMMANDS);
});

test('leaving, withdrawing and exporting your own data are never throttled', () => {
  for (const command of [
    'creator.deleteExperience',
    'creator.changeVisibility',
    'creator.requestExport',
    'dispute.withdraw',
  ]) {
    assert.equal(quotaClassOf(command), undefined, `${command} is unthrottled`);
  }
});

test('operator actions are governed by the policy matrix rather than by a quota', () => {
  for (const command of [
    'safety.applyModerationAction',
    'safety.claimQueueItem',
    'governance.grantRole',
    'proposal.decide',
    'dispute.review',
  ]) {
    assert.equal(quotaClassOf(command), undefined, `${command} is unthrottled`);
  }
});

test('a command nobody classified falls into interaction rather than into nothing', () => {
  // Fail-safe direction: an unclassified command is counted, not exempt. The
  // alternative is that adding a command silently creates an unthrottled path.
  assert.equal(quotaClassOf('some.commandAddedLater'), 'interaction');
});

test('the corroboration primitive has its own class, separate from authoring', () => {
  assert.equal(quotaClassOf('corroboration.create'), 'corroboration');
  assert.equal(quotaClassOf('experience.create'), 'authoring');
  assert.equal(quotaClassOf('voice.attachAsset'), 'upload');
  assert.equal(quotaClassOf('identity.register'), 'identity');
});

test('every classified command names a real class', () => {
  for (const [command, quotaClass] of Object.entries(QUOTA_CLASS_BY_COMMAND)) {
    assert.ok(QUOTA_CLASSES.includes(quotaClass), `${command} → ${quotaClass}`);
  }
});

test('no command is both classified and exempt', () => {
  for (const command of Object.keys(UNTHROTTLED_COMMANDS)) {
    assert.ok(!(command in QUOTA_CLASS_BY_COMMAND), `${command} is one or the other`);
  }
});

test('every exemption carries its reason', () => {
  for (const [command, reason] of Object.entries(UNTHROTTLED_COMMANDS)) {
    assert.ok(reason.length > 10, `${command} says why it is exempt`);
  }
});

// ── A quota is not a judgement ────────────────────────────────────────────
test('a throttle message says when to come back and accuses nobody', () => {
  const soon = throttleMessage(30_000);
  assert.match(soon, /Try again in about 30 seconds/);
  assert.match(throttleMessage(20 * 60_000), /about 20 minutes/);
  for (const message of [soon, throttleMessage(20 * 60_000)]) {
    for (const word of ['suspicious', 'abuse', 'spam', 'violation', 'blocked', 'banned']) {
      assert.ok(!message.toLowerCase().includes(word), `a quota does not say "${word}"`);
    }
  }
});

test('a quota reaches no judgement, and nobody can be throttled harder than the policy', () => {
  assert.equal(quotaSignalsForTrust(), undefined);
  assert.equal(setQuotaForActor(), undefined);
});

test('no module that decides an outcome so much as mentions the quota module', () => {
  // The same discovery guard Phase 48 uses for entitlement, pointed at quotas. A
  // throttle count that could be read by trust, severity or priority would turn
  // "posted quickly" into evidence — and the people most likely to post quickly are
  // the ones something is actively happening to.
  const walk = (dir: string): readonly string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.ts')) out.push(path);
    }
    return out;
  };

  const offenders: string[] = [];
  for (const root of INTEGRITY_SCAN_ROOTS) {
    for (const file of walk(join(engineRoot, root))) {
      // The quota module itself, and the guard that implements it, are the boundary.
      if (file.endsWith(join('domain', 'quota.ts'))) continue;
      const source = readFileSync(file, 'utf8');
      if (/\bquota\b/i.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) {
        offenders.push(file.slice(engineRoot.length + 1));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `no engine or domain module may read a throttle count:\n${offenders.join('\n')}`,
  );
});
