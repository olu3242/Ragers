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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx next start -p 3101',
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
