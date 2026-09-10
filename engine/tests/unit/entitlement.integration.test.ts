import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ENTITLEMENT_VOCABULARY,
  ENTITLED_FEATURES,
  INTEGRITY_MODULES,
  entitlementFor,
  integrityInputsFor,
  mayUse,
} from '../../src/domain/entitlement.ts';
import {
  createSubscription,
  forbiddenKeysIn,
  mayReceive,
  serialise,
  sign,
  verify,
  type DeliveryPayload,
  type Subscription,
} from '../../src/domain/integration.ts';

/**
 * Phases 48–49.
 *
 * The Phase 48 certification is that paid and unpaid treatment is identical *at the
 * integrity layer*, and the roadmap is explicit that this must not be a policy statement to
 * be trusted. So the first test reads the integrity modules off disk and asserts they contain
 * no entitlement vocabulary at all — a stronger guarantee than "we would notice in review",
 * and the one the phase actually asks for.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── Phase 48 — the integrity layer is blind to payment ──────────────────
test('no integrity module references entitlement, in any spelling', () => {
  for (const module of INTEGRITY_MODULES) {
    const source = stripComments(read(module));
    for (const word of ENTITLEMENT_VOCABULARY) {
      assert.equal(
        source.toLowerCase().includes(word.toLowerCase()),
        false,
        `${module} mentions ${word}; the integrity layer must have no input for entitlement at all`,
      );
    }
    assert.equal(
      source.includes('entitlement.ts'),
      false,
      `${module} imports the entitlement module`,
    );
  }
});

test('the integrity modules named actually exist, so the guard is not vacuous', () => {
  // A list of filenames is worthless if a rename silently empties it.
  assert.ok(INTEGRITY_MODULES.length >= 12);
  for (const module of INTEGRITY_MODULES) {
    assert.ok(read(module).length > 0, `${module} must exist`);
  }
});

test('an entitlement contributes nothing to any integrity decision', () => {
  const paid = entitlementFor('org_1', 'professional', 1);
  assert.equal(integrityInputsFor(paid), undefined);
  assert.equal(integrityInputsFor(undefined), undefined);
});

test('a plan has no field that could alter an outcome', () => {
  const paid = entitlementFor('org_1', 'professional', 1);
  for (const key of Object.keys(paid)) {
    assert.equal(
      /boost|priority|rank|visib|suppress|moderat|weight/i.test(key),
      false,
      `a plan must not carry ${key}`,
    );
  }
  // Every feature is a read. None of them is an action on somebody else's content.
  for (const feature of ENTITLED_FEATURES) {
    assert.equal(/remove|hide|suppress|promote|boost/i.test(feature), false, feature);
  }
});

test('a paid plan unlocks reads, and an absent plan unlocks none', () => {
  assert.equal(mayUse(entitlementFor('org_1', 'professional', 1), 'benchmark_reports'), true);
  assert.equal(mayUse(entitlementFor('org_1', 'basic', 1), 'benchmark_reports'), false);
  assert.equal(mayUse(undefined, 'issue_alerts'), false);
});

// ── Phase 49 — signing, isolation, payload ──────────────────────────────
const subscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub_1',
  organizationId: 'org_1',
  endpointUrl: 'https://example.test/hook',
  events: ['resolution.reported'],
  secret: 'x'.repeat(32),
  isActive: true,
  createdAt: 1,
  ...overrides,
});

test('an endpoint must be https, and a secret must be long enough to be worth signing with', () => {
  const insecure = createSubscription(
    { organizationId: 'org_1', endpointUrl: 'http://example.test/hook', events: ['resolution.reported'], secret: 'x'.repeat(32) },
    { id: 'sub_1', now: 1 },
  );
  assert.equal(insecure.ok, false);
  if (!insecure.ok) assert.equal(insecure.error.code, 'endpoint_must_be_https');

  const weak = createSubscription(
    { organizationId: 'org_1', endpointUrl: 'https://example.test/hook', events: ['resolution.reported'], secret: 'short' },
    { id: 'sub_1', now: 1 },
  );
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.error.code, 'secret_too_short');
});

test('an unknown event is refused rather than silently dropped', () => {
  const bogus = createSubscription(
    { organizationId: 'org_1', endpointUrl: 'https://example.test/hook', events: ['everything'], secret: 'x'.repeat(32) },
    { id: 'sub_1', now: 1 },
  );
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.equal(bogus.error.code, 'unknown_event');
});

test('a signature verifies over the exact bytes, and a tampered body does not', () => {
  const payload: DeliveryPayload = {
    event: 'resolution.reported',
    organizationId: 'org_1',
    subjectId: 'exp_1',
    occurredAt: 1,
    data: { experienceId: 'exp_1' },
  };
  const body = serialise(payload);
  const signature = sign('secret-secret-secret-secret-1234', body);
  assert.equal(verify('secret-secret-secret-secret-1234', body, signature), true);
  assert.equal(verify('secret-secret-secret-secret-1234', `${body} `, signature), false);
  assert.equal(verify('a-different-secret-of-good-length', body, signature), false);
});

test('a malformed signature is rejected without throwing', () => {
  const body = 'x';
  assert.equal(verify('secret-secret-secret-secret-1234', body, 'not-hex'), false);
  assert.equal(verify('secret-secret-secret-secret-1234', body, ''), false);
});

test('a tenant only ever receives its own events', () => {
  const own = subscription();
  assert.equal(mayReceive(own, 'resolution.reported', 'org_1'), true);
  // The same event, a different organization. There is no subscription shape that can ask
  // for another tenant's events, and this is the check that says so.
  assert.equal(mayReceive(own, 'resolution.reported', 'org_2'), false);
  assert.equal(mayReceive(own, 'dispute.opened', 'org_1'), false, 'and only the events it asked for');
  assert.equal(mayReceive(subscription({ isActive: false }), 'resolution.reported', 'org_1'), false);
});

test('a payload carries ids and counts, never content or an author', () => {
  const clean: DeliveryPayload = {
    event: 'resolution.reported',
    organizationId: 'org_1',
    subjectId: 'exp_1',
    occurredAt: 1,
    data: { experienceId: 'exp_1', reporters: 2 },
  };
  assert.deepEqual([...forbiddenKeysIn(clean)], []);

  // A payload that grew a body is caught rather than sent: a leaked webhook log must not be
  // a leaked corpus.
  const leaky = { ...clean, data: { experienceId: 'exp_1', bodyText: 'what happened' } };
  assert.deepEqual([...forbiddenKeysIn(leaky)], ['bodyText']);
  const identifying = { ...clean, data: { experienceId: 'exp_1', actorId: 'act_1' } };
  assert.deepEqual([...forbiddenKeysIn(identifying)], ['actorId']);
});

test('no read path returns a signing secret', () => {
  const source = stripComments(read('src/engines/integration.engine.ts'));
  // The engine signs with it and never returns it. `publicSubscriptionView` is the shape a
  // caller gets.
  assert.match(source, /publicSubscriptionView/);
  const view = stripComments(source.slice(source.indexOf('publicSubscriptionView')));
  assert.equal(view.includes('secret'), false, 'the public view must not include the secret');
});
