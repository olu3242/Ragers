import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineHarness } from '../support/engine-harness.ts';
import { readiness, readinessIsHealth } from '../../src/engines/observability.engine.ts';
import { createFakeObjectStore } from '../../src/adapters/fakes.ts';
import type { ObjectStore } from '../../src/ports/providers.ts';

/**
 * RC3: what `/api/readiness` has to be able to say.
 *
 * The checks added in this batch all share one shape: **a fact no probe could discover by asking.**
 * An in-memory store answers every query; the in-process object store answers `put`, `exists` and
 * `remove` successfully; a deployment where nobody can sign in serves reads perfectly. Each is
 * healthy and unfit, which is the distinction the endpoint exists for — so each is *declared* by the
 * composition root and interpreted here, rather than guessed at.
 */

/** A durable object store, standing in for a configured bucket. */
const durableStore = (): ObjectStore => ({ ...createFakeObjectStore(), name: 'stub-bucket', durable: true });

const checkOf = (report: Awaited<ReturnType<typeof readiness>>, name: string) =>
  report.checks.find((check) => check.name === name);

test('a local process is ready while being neither persistent nor durable', async () => {
  // The point of the `hosted` fact. `npm run dev` and the whole test suite are legitimately
  // in-memory, and a probe that failed there would be noise rather than information.
  const h = createEngineHarness();
  const report = await readiness(h.engine, { persistentStore: false, hosted: false });

  assert.equal(checkOf(report, 'persistent_store')?.ok, true, 'not a deployment, so not a failure');
  assert.equal(checkOf(report, 'object_storage')?.ok, true);
  // And it still *says* what it is, so somebody reading the body is not misled.
  assert.match(checkOf(report, 'persistent_store')?.detail ?? '', /in-memory/);
  assert.match(checkOf(report, 'object_storage')?.detail ?? '', /in-process/);
});

test('a hosted process holding everything in memory is not ready', async () => {
  const h = createEngineHarness();
  const report = await readiness(h.engine, { persistentStore: false, hosted: true });

  assert.equal(report.ready, false, 'a hosted instance that loses state on restart is unfit');
  assert.equal(checkOf(report, 'persistent_store')?.ok, false);
  assert.match(
    checkOf(report, 'persistent_store')?.detail ?? '',
    /lost on restart/,
    'and the reason names the consequence rather than the configuration',
  );
});

test('a hosted process with a non-durable object store is not ready', async () => {
  const h = createEngineHarness();
  const notDurable = await readiness(h.engine, { persistentStore: true, hosted: true });
  assert.equal(checkOf(notDurable, 'object_storage')?.ok, false);
  assert.match(checkOf(notDurable, 'object_storage')?.detail ?? '', /do not outlive the process/);

  const configured = createEngineHarness({ providers: { objectStore: durableStore() } });
  const durable = await readiness(configured.engine, { persistentStore: true, hosted: true });
  assert.equal(checkOf(durable, 'object_storage')?.ok, true);
  assert.match(checkOf(durable, 'object_storage')?.detail ?? '', /stub-bucket/, 'named, so it is checkable');
});

test('a hosted process where nobody can sign in is not ready', async () => {
  /**
   * **The state RC2 actually shipped**, and nothing reported it: running, healthy, every read
   * correct, and unusable by anybody who was not already holding a session. A readiness surface that
   * cannot say that is not answering "may a balancer send me requests".
   */
  const permissive = createEngineHarness({ config: { allowPasswordlessSignIn: true } });
  const report = await readiness(permissive.engine, { persistentStore: true, hosted: true });
  assert.equal(report.ready, false, 'skipping the credential check is a development setting');
  assert.equal(checkOf(report, 'sign_in')?.ok, false);
  assert.match(checkOf(report, 'sign_in')?.detail ?? '', /must not be deployed/);

  // With the credential check on and the store answering, sign-in is possible.
  const proper = createEngineHarness();
  const ok = await readiness(proper.engine, { persistentStore: true, hosted: true });
  assert.equal(checkOf(ok, 'sign_in')?.ok, true);
  assert.match(checkOf(ok, 'sign_in')?.detail ?? '', /a credential is required/);
});

test('a dependency that is down makes the instance unready and names itself', async () => {
  // The negative case the batch asks for, driven by breaking the port rather than by mocking the
  // check: the readiness function must discover it, not be told.
  const h = createEngineHarness();
  const broken = {
    ...h.engine.store,
    actors: {
      ...h.engine.store.actors,
      count: async () => {
        throw new Error('connection refused');
      },
    },
  };
  const report = await readiness({ ...h.engine, store: broken } as never, {
    persistentStore: true,
    hosted: true,
  });
  assert.equal(report.ready, false);
  assert.equal(checkOf(report, 'store')?.ok, false);
  assert.match(checkOf(report, 'store')?.detail ?? '', /did not answer/);
});

test('no check leaks a secret, and every check explains itself', async () => {
  /**
   * A readiness endpoint is usually the most reachable thing a deployment has — no auth, no rate
   * limit, hit by a balancer every few seconds. So the body is swept rather than trusted: providers
   * are named, the store is described as configured or not, and nothing that could be a credential
   * appears.
   */
  const h = createEngineHarness({ providers: { objectStore: durableStore() } });
  const report = await readiness(h.engine, { persistentStore: true, hosted: true });
  const body = JSON.stringify(report);

  for (const forbidden of ['postgres://', 'postgresql://', 'password', 'secret', 'token', 'Bearer', 'key=']) {
    assert.equal(
      body.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `readiness must not mention ${forbidden}`,
    );
  }
  for (const check of report.checks) {
    assert.ok(check.detail.length > 10, `${check.name} explains itself`);
  }
  // Providers are reported and never gate: a deterministic fallback is a degraded product, not an
  // unfit instance, and taking a deployment out of rotation over it would be the wrong trade.
  assert.equal(checkOf(report, 'providers')?.ok, true);
  assert.match(checkOf(report, 'providers')?.detail ?? '', /deterministic fallback/);

  assert.equal(readinessIsHealth(), false);
});
