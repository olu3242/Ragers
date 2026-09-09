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
  ],
  webServer: [
    {
      command: 'npx next start -p 3101',
      url: 'http://127.0.0.1:3101',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx next start -p 3102',
      url: 'http://127.0.0.1:3102',
      reuseExistingServer: false,
      timeout: 120_000,
      // Only this server has the fixture route at all, so the golden-path server
      // is exactly what a deployment runs.
      env: { RAGERS_TEST_SEED: 'enabled' },
    },
  ],
});
