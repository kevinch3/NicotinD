import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

/**
 * When E2E_BASE_URL is set we run against an already-running instance (e.g. prod
 * smoke: E2E_BASE_URL=https://nicotined.kevinroberts.ar) and skip the webServer.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
// Dedicated port for the managed test server so it never collides with a
// developer's running instance on the default 8484.
const PORT = process.env.E2E_PORT ?? '8585';
const baseURL = externalBaseUrl ?? `http://localhost:${PORT}`;

// The setup wizard only runs when zero users exist, but the main server is
// seeded with an admin by the setup project — so the `onboarding` spec drives a
// SECOND, never-seeded server on its own port/DB. See docs/e2e.md.
const ONBOARDING_PORT = process.env.E2E_ONBOARDING_PORT ?? '8586';

// Fresh DB per run so the first user is always our admin (deterministic setup).
// Done at config-eval time — before Playwright launches the webServer — because
// the webServer opens the SQLite DB on boot and a globalSetup hook would be too
// late. Only wipe the local throwaway dirs, never when pointed at an external URL.
const dataDir = resolve(__dirname, '.tmp-data');
const onboardingDataDir = resolve(__dirname, '.tmp-data-onboarding');
if (!externalBaseUrl) {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(onboardingDataDir, { recursive: true, force: true });
}

// Gated playground mode: PLAYGROUND=1 runs ONLY the `*.playground.ts` feedback
// flows (against a live backend via E2E_BASE_URL, or the managed server in
// degraded mode) and writes a findings report via the custom reporter. It stays
// out of the CI `e2e` job — see docs/e2e.md "Playground harness".
const playground = !!process.env.PLAYGROUND;
const PLAYGROUND_RE = /\.playground\.ts$/;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: playground
    ? [['./playground/reporter.ts'], ['list']]
    : process.env.CI
      ? [['html', { open: 'never' }], ['list']]
      : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: playground
    ? [
        { name: 'playground-setup', testMatch: /playground\.setup\.ts/ },
        {
          name: 'playground',
          testMatch: PLAYGROUND_RE,
          use: { ...devices['Desktop Chrome'], storageState: '.auth/playground.json' },
          dependencies: ['playground-setup'],
        },
      ]
    : correctnessProjects(),
  webServer: externalBaseUrl
    ? undefined
    : [makeServer(PORT, dataDir), makeServer(ONBOARDING_PORT, onboardingDataDir)],
});

/**
 * The correctness projects. `onboarding` runs the setup-wizard spec against the
 * dedicated never-seeded server (no `storageState`, no `setup` dependency) so it
 * sees `needsSetup: true`; the rest of the suite runs against the seeded server.
 * The onboarding project is skipped in external mode — you must never drive the
 * setup wizard against a real instance.
 */
function correctnessProjects(): PlaywrightTestConfig['projects'] {
  const projects: NonNullable<PlaywrightTestConfig['projects']> = [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      // The correctness suite never runs the playground flows, and the onboarding
      // wizard needs a never-seeded server (its own project below).
      testIgnore: [PLAYGROUND_RE, /onboarding\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
  ];
  if (!externalBaseUrl) {
    projects.push({
      name: 'onboarding',
      testMatch: /onboarding\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${ONBOARDING_PORT}` },
    });
  }
  return projects;
}

/** Build a managed server config on the given port + throwaway data dir. */
function makeServer(port: string, dir: string): NonNullable<PlaywrightTestConfig['webServer']> {
  return {
    command: 'bun run src/main.ts',
    cwd: repoRoot,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NICOTIND_PORT: port,
      NICOTIND_MODE: 'external', // never spawn slskd; no Soulseek creds set
      // Point at a dead slskd so the test server can't reach (or mutate) any
      // real instance on the default :5030. Acquisition is default-off anyway;
      // boot tolerates an unreachable slskd.
      NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
      NICOTIND_LIDARR_URL: 'http://127.0.0.1:1', // likewise isolate from a real Lidarr
      NICOTIND_DATA_DIR: dir,
      NICOTIND_MUSIC_DIR: resolve(__dirname, 'fixtures/music'),
    },
  };
}
