import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards on the host's HTTP surface.
 *
 * The one that matters most: the fixture-seeding route creates taxonomy rows and
 * can enrol the caller as an organization's staff. Reachable in a deployment,
 * that is a path for anyone to become an organization and start answering — the
 * exact thing the organization rules exist to prevent. So the guard's presence is
 * asserted here rather than trusted, and asserted to be the *first* thing the
 * handler does.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..', 'app');

const walk = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
};

const routes = walk(appDir);

test('the fixture route refuses before it does anything', () => {
  const file = routes.find((route) => route.includes(join('api', 'test', 'seed')));
  assert.ok(file, 'the fixture route exists');
  const source = readFileSync(file as string, 'utf8');

  assert.match(
    source,
    /RAGERS_TEST_SEED'\]\s*===\s*'enabled'/,
    'gated on an explicit flag, not on NODE_ENV — a stray NODE_ENV must not open it',
  );

  // The guard must precede every write. Compare positions rather than trusting
  // that a reader will notice.
  const guardAt = source.indexOf('if (!ENABLED())');
  const firstWrite = source.search(/store\.[A-Za-z]+\.put\(/);
  assert.ok(guardAt > 0, 'the handler checks the flag');
  assert.ok(
    guardAt < firstWrite,
    'the refusal comes before the first write, so a misconfiguration cannot leak a partial seed',
  );

  assert.match(source, /notFoundError/, 'it answers as though it does not exist, rather than 403');
});

test('no route other than the fixture route reads a test flag', () => {
  for (const file of routes) {
    if (file.includes(join('api', 'test', 'seed'))) continue;
    const source = readFileSync(file, 'utf8');
    assert.equal(
      /RAGERS_TEST|NODE_ENV\s*===\s*'test'/.test(source),
      false,
      `${relative(appDir, file)} must not branch on a test flag`,
    );
  }
});

test('every write route requires an idempotency key and a correlation id', () => {
  for (const file of routes) {
    const source = readFileSync(file, 'utf8');
    if (!/bus\.dispatch\(/.test(source)) continue;
    assert.match(
      source,
      /idempotencyKey: idempotencyKeyFrom\(request\)/,
      `${relative(appDir, file)} dispatches without an idempotency key`,
    );
    assert.match(
      source,
      /correlationId: correlationIdFrom\(request\)/,
      `${relative(appDir, file)} dispatches without a correlation id`,
    );
  }
});

test('no route reads an original media key or a raw transcript', () => {
  for (const file of routes) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of ['originalKey', 'rawText']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${relative(appDir, file)} must not touch ${forbidden}`,
      );
    }
  }
});
