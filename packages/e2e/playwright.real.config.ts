import { defineConfig, devices } from '@playwright/test';

/**
 * REAL round-trip against a LIVE backend (prod) — the only config that performs
 * genuinely mutating acquisition: it acquires an album, verifies it lands in the
 * library and is playable, then DELETES it (real removal) in teardown so prod is
 * left clean. Opt-in and never in CI.
 *
 * Requires E2E_BASE_URL *and* PLAYGROUND_REAL=1 (a deliberate two-key guard so a
 * stray `playwright test` can never trigger real downloads/removals). Auth via
 * PLAYGROUND_USERNAME / PLAYGROUND_PASSWORD through playground.setup.ts. Emits the
 * findings report via the playground reporter.
 *
 * Run:
 *   E2E_BASE_URL=https://your-stack PLAYGROUND_REAL=1 \
 *   PLAYGROUND_USERNAME=you PLAYGROUND_PASSWORD=… \
 *   PLAYGROUND_REAL_URL=https://… \
 *   bun run --filter @nicotind/e2e playground:real
 * (or PLAYGROUND_REAL_ARTIST=… PLAYGROUND_REAL_ALBUM=… to drive the hunt path.)
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('E2E_BASE_URL is required for the real round-trip (live backend).');
if (process.env.PLAYGROUND_REAL !== '1') {
  throw new Error(
    'Refusing to run the REAL round-trip without PLAYGROUND_REAL=1 — it performs real downloads and removals.',
  );
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  // Generous: a real download + organize + scan can take minutes.
  timeout: 15 * 60_000,
  reporter: [['./playground/reporter.ts'], ['list']],
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'setup', testMatch: /playground\.setup\.ts/ },
    {
      name: 'real',
      testMatch: /real-roundtrip\.real\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/playground.json' },
      dependencies: ['setup'],
    },
  ],
  // No webServer: this only ever runs against the external live instance.
});
