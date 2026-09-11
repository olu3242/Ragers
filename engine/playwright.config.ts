import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

/**
 * Browser E2E runs against a real production build, started the way a
 * deployment starts it — so the gate exercises the shipped artifact, not a dev
 * server with different behaviour.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    trace: 'off',
    // Grant microphone access so the voice path can be driven without a prompt.
    permissions: ['microphone'],
    launchOptions: {
      // Use the Chromium already present in this environment rather than
      // downloading a second copy; RAGERS_CHROMIUM overrides it elsewhere.
      executablePath: process.env['RAGERS_CHROMIUM'] ?? '/opt/pw-browsers/chromium',
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-sandbox',
      ],
    },
  },
  /**
   * Two servers, so each suite gets a clean process.
   *
   * The engine holds state in the server process, so one shared server would make
   * every assertion about "the feed" depend on what another spec had already
   * posted — and the first symptom of that is a strict-mode violation, not a clear
   * failure. Separate ports keep both suites deterministic and let the golden path
   * legitimately assert an empty feed.
   *
   * **Which is why every server below pins `DATABASE_URL` empty.** Separate processes stop
   * sharing state the moment they share a database, and the certification workflow sets
   * `DATABASE_URL` at job level for the live gates — so without this the five servers would
   * all reach the same Postgres and the isolation these ports exist for would be gone. It is
   * not a hypothetical: it failed 23 of 30 browser tests. The browser gate certifies what the
   * shipped UI does with the engine behind it; that the engine can be backed by Postgres is
   * the live suite's job, against its own database, one process at a time.
   */
  projects: [
    {
      name: 'golden-path',
      testMatch: /golden-path\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3101' },
    },
    {
      name: 'experience-signal-engine',
      testMatch: /experience-signal-engine\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3102' },
    },
    {
      // Its own server: these tests promote their own session to moderator and to
      // organization staff, which must not leak into another suite's assumptions.
      name: 'personas',
      testMatch: /personas\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3103' },
    },
    {
      name: 'relate-reputation',
      testMatch: /relate-reputation\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3104' },
    },
    {
      // Its own server again: these tests assert on an *absent* severity band, which
      // another suite's asserted band on a shared feed would defeat.
      name: 'governance-action',
      testMatch: /governance-action\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3105' },
    },
  ],
  webServer: [
    {
      command: 'npx next start -p 3101',
      url: 'http://127.0.0.1:3101',
      reuseExistingServer: false,
      timeout: 120_000,
      // No RAGERS_TEST_SEED: this server is exactly what a deployment runs, which is what lets
      // the golden path assert the fixture route is absent and that sign-in is refused.
      env: { DATABASE_URL: '' },
    },
    {
      command: 'npx next start -p 3102',
      url: 'http://127.0.0.1:3102',
      reuseExistingServer: false,
      timeout: 120_000,
      // Only this server has the fixture route at all, so the golden-path server
      // is exactly what a deployment runs.
      // RAGERS_TEST_SEED also permits passwordless sign-in, which four specs need and no
      // deployment has. DATABASE_URL empty: see the comment above the project list.
      env: { RAGERS_TEST_SEED: 'enabled', DATABASE_URL: '' },
    },
    {
      command: 'npx next start -p 3103',
      url: 'http://127.0.0.1:3103',
      reuseExistingServer: false,
      timeout: 120_000,
      // RAGERS_TEST_SEED also permits passwordless sign-in, which four specs need and no
      // deployment has. DATABASE_URL empty: see the comment above the project list.
      env: { RAGERS_TEST_SEED: 'enabled', DATABASE_URL: '' },
    },
    {
      command: 'npx next start -p 3104',
      url: 'http://127.0.0.1:3104',
      reuseExistingServer: false,
      timeout: 120_000,
      // RAGERS_TEST_SEED also permits passwordless sign-in, which four specs need and no
      // deployment has. DATABASE_URL empty: see the comment above the project list.
      env: { RAGERS_TEST_SEED: 'enabled', DATABASE_URL: '' },
    },
    {
      command: 'npx next start -p 3105',
      url: 'http://127.0.0.1:3105',
      reuseExistingServer: false,
      timeout: 120_000,
      // RAGERS_TEST_SEED also permits passwordless sign-in, which four specs need and no
      // deployment has. DATABASE_URL empty: see the comment above the project list.
      env: { RAGERS_TEST_SEED: 'enabled', DATABASE_URL: '' },
    },
  ],
});
