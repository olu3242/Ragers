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

    // Every `idempotencyKey:` in the file must derive from the request, rather than
    // one of them doing so and the rest inventing a value. This is stricter than
    // matching the exact expression once, and it admits a *derived* key — a route
    // that dispatches two commands for one request must not give them the same key,
    // or the second is swallowed as a replay of the first.
    const keys = [...source.matchAll(/idempotencyKey:\s*([^,\n]+)/g)].map((match) => match[1] ?? '');
    assert.ok(keys.length > 0, `${relative(appDir, file)} dispatches without an idempotency key`);
    for (const key of keys) {
      assert.match(
        key,
        /idempotencyKeyFrom\(request\)/,
        `${relative(appDir, file)} has an idempotency key not derived from the request: ${key}`,
      );
    }

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

/**
 * The composition root.
 *
 * Two P1s on PR #5 were both *absences at the root* rather than faults in any engine: the engine
 * was constructed with no arguments, so `DATABASE_URL` did nothing, and sign-in issued a session
 * from an email address alone. Neither was reachable by a unit test of an engine, because both
 * engines were correct. So they are asserted here, over the wiring itself.
 */
const libDir = join(here, '..', '..', 'lib');
const read = (...parts: readonly string[]): string => readFileSync(join(here, '..', '..', ...parts), 'utf8');
/** Comments describe the defect by name, so every sweep below reads the code and not the prose. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('both entry points build the engine from the configured database, and pass db rather than store', () => {
  for (const entry of [['lib', 'engine-instance.ts'], ['scripts', 'worker.ts']] as const) {
    const source = code(read(...entry));
    const label = entry.join('/');
    assert.match(source, /configuredDb\(\)/, `${label} reads the configured database`);
    assert.equal(
      /createEngine\(\)/.test(source),
      false,
      `${label} must not construct an engine with no arguments — that is the defect, exactly`,
    );
    // **`db`, not `store`.** A store alone persists the domain rows and leaves the outbox, the
    // idempotency store, the delivery ledger and the transaction boundary in process memory, so a
    // restart loses undelivered events and a separate worker drains nothing. The first fix for
    // this defect did that, and it looked finished.
    assert.match(source, /\{ db \}/, `${label} passes db, so the runtime stores are Postgres too`);
  }
});

test('the application tier is configured by DATABASE_URL and never by a test variable', () => {
  const codeOnly = code(readFileSync(join(libDir, 'engine-store.ts'), 'utf8'));
  assert.match(codeOnly, /process\.env\['DATABASE_URL'\]/);
  assert.equal(
    /RAGERS_TEST_DATABASE_URL/.test(codeOnly),
    false,
    'the harness variable is exported whenever a live database is available; honouring it here would '
      + 'change which backend the browser gate exercises depending on the environment',
  );
});

test('passwordless sign-in rides the fixture gate and nothing else', () => {
  const codeOnly = code(readFileSync(join(libDir, 'engine-store.ts'), 'utf8'));
  // One switch, already asserted off by default above and already recorded as never-in-a-deployment.
  // A variable of its own would be a second thing to leave on.
  assert.match(codeOnly, /passwordlessSignInAllowed[\s\S]*RAGERS_TEST_SEED'\]\s*===\s*'enabled'/);
  assert.equal(
    /NODE_ENV|ALLOW_PASSWORDLESS|RAGERS_ALLOW/.test(codeOnly),
    false,
    'not NODE_ENV and not a second flag',
  );
  // The worker dispatches no sign-in, so the permissive setting must not reach it at all.
  assert.equal(
    /passwordlessSignInAllowed/.test(code(read('scripts', 'worker.ts'))),
    false,
    'the standalone worker is not given a sign-in permission it has no use for',
  );
});

test('every browser server is isolated from the others, which means pinning DATABASE_URL empty', () => {
  // Separate ports stop isolating processes the moment those processes share a database, and the
  // certification workflow sets DATABASE_URL at job level for the live gates. Without this pin the
  // five servers all reach one Postgres and the suites contaminate each other — 23 of 30 browser
  // tests failed that way, and the symptom was "the feed does not contain this text", which reads
  // like a UI bug rather than a configuration one.
  const config = code(read('playwright.config.ts'));
  const servers = [...config.matchAll(/command:\s*'npx next start -p (\d+)'/g)].map((m) => m[1]);
  assert.ok(servers.length >= 2, 'the browser gate runs a server per suite');
  const pinned = [...config.matchAll(/DATABASE_URL:\s*''/g)].length;
  assert.equal(pinned, servers.length, `each of ${servers.length} servers pins DATABASE_URL empty`);
});

/**
 * RC3: what a hosted deployment refuses to do.
 *
 * Each of these is a configuration mistake that produces no error at a request — the process comes
 * up, serves traffic, and is wrong. So they are refused at construction or asserted over the
 * wiring, which is the only place the mistake is still visible.
 */
test('a hosted deployment refuses to start without a database, and a local one does not', async () => {
  const store = await import('../../lib/engine-store.ts');
  const saved = { ...process.env };
  try {
    // Hosted and unconfigured: refuse. Losing state on restart is not an error any request could
    // report — the symptom is a person's account appearing not to exist.
    delete process.env['DATABASE_URL'];
    process.env['RAGERS_DEPLOYMENT'] = 'production';
    assert.throws(() => store.configuredDb(), /DATABASE_URL is required/);
    assert.equal(store.isHostedDeployment(), true);
    assert.equal(store.isPersistent(), false, 'and it reports itself as not persisting');

    // Local and unconfigured: in-memory, because `npm run dev` must not need a database.
    process.env['RAGERS_DEPLOYMENT'] = 'local';
    assert.equal(store.configuredDb(), undefined);
    assert.equal(store.isHostedDeployment(), false);

    // Undeclared is treated as hosted for this check. The two defaults point in opposite
    // directions on purpose: each fails towards refusing rather than towards serving.
    delete process.env['RAGERS_DEPLOYMENT'];
    delete process.env['VERCEL'];
    delete process.env['VERCEL_ENV'];
    assert.equal(store.isHostedDeployment(), false, 'undeclared is local for convenience decisions');
    process.env['VERCEL'] = '1';
    assert.equal(store.isHostedDeployment(), true, 'and a platform signal is enough to be hosted');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the session cookie is Secure on every hosted deployment', async () => {
  const store = await import('../../lib/engine-store.ts');
  const saved = { ...process.env };
  try {
    process.env['RAGERS_DEPLOYMENT'] = 'production';
    const hosted = store.cookieAttributes();
    assert.match(hosted, /HttpOnly/, 'unreachable from page scripts, always');
    assert.match(hosted, /Secure/, 'and never sent in clear');
    // Lax rather than Strict: Strict drops the cookie on a cross-site navigation, so following a
    // link to a Rager from anywhere else would land the reader signed out. Lax still refuses the
    // cookie on cross-site POSTs, which is the CSRF-relevant half.
    assert.match(hosted, /SameSite=Lax/);

    // Not on plain local HTTP, where a browser silently drops a Secure cookie and sign-in would
    // appear to fail with nothing in any log to explain it.
    process.env['RAGERS_DEPLOYMENT'] = 'local';
    const local = store.cookieAttributes();
    assert.match(local, /HttpOnly/);
    assert.equal(/Secure/.test(local), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the deployment check does not read NODE_ENV', () => {
  // `next build` sets NODE_ENV=production on a laptop, so a check on it would call a local
  // production build hosted — and, far worse, would call a real deployment that forgot to set it
  // *local*, failing open in exactly the case that matters.
  const source = code(readFileSync(join(libDir, 'engine-store.ts'), 'utf8'));
  assert.equal(/NODE_ENV/.test(source), false, 'the deployment signal is explicit, not inferred');
  assert.match(source, /RAGERS_DEPLOYMENT/);
});
