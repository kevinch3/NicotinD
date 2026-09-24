import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { TV_DIST, ensureWebBuild } from './ensure-web-build.js';
import {
  E2E_MUSIC_DIR,
  ONBOARDING_MUSIC_DIR,
  TV_BUILD_MUSIC_DIR,
  copyMusicFixtures,
} from './fixture-music.js';

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

// The TV route tree is a BUILD-time fork (`environment.tvBuild`, docs/tv-ux.md),
// so stamping the `tv-build` class on the phone bundle never renders it. The `tv`
// project drives a THIRD managed server that serves the `--configuration tv`
// bundle through NICOTIND_WEB_DIST (#1136). 8587 is the emulator lane's port.
const TV_PORT = process.env.E2E_TV_CHROMIUM_PORT ?? '8588';

// Fresh DB per run so the first user is always our admin (deterministic setup).
// Done at config-eval time — before Playwright launches the webServer — because
// the webServer opens the SQLite DB on boot and a globalSetup hook would be too
// late. Only wipe the local throwaway dirs, never when pointed at an external URL.
const dataDir = resolve(__dirname, '.tmp-data');
const onboardingDataDir = resolve(__dirname, '.tmp-data-onboarding');
const tvDataDir = resolve(__dirname, '.tmp-data-tvbuild');
if (!externalBaseUrl) {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(onboardingDataDir, { recursive: true, force: true });
  rmSync(tvDataDir, { recursive: true, force: true });
  // The server writes into its music dir (lyrics and analysis tags, deletes,
  // landed downloads), so each server gets its own copy of the tracked fixtures
  // (#1320). Main process only: Playwright re-evaluates this file in every
  // worker, and re-copying there would pull the tree out from under a running
  // server mid-suite.
  if (process.env.TEST_WORKER_INDEX === undefined) {
    copyMusicFixtures(E2E_MUSIC_DIR);
    copyMusicFixtures(ONBOARDING_MUSIC_DIR);
    copyMusicFixtures(TV_BUILD_MUSIC_DIR);
  }
}

// The managed server serves the prebuilt packages/web/dist, so build it here —
// same config-eval timing and same external-URL gate as the wipe above. See
// ensure-web-build.ts for why this isn't a globalSetup or a root-script change.
ensureWebBuild();

// Gated playground mode: PLAYGROUND=1 runs ONLY the `*.playground.ts` feedback
// flows (against a live backend via E2E_BASE_URL, or the managed server in
// degraded mode) and writes a findings report via the custom reporter. It stays
// out of the CI `e2e` job — see docs/e2e.md "Playground harness".
const playground = !!process.env.PLAYGROUND;
const PLAYGROUND_RE = /\.playground\.ts$/;
// The TV project's specs, kept out of the `chromium` project by name.
const TV_BUILD_RE = /\.tvbuild\.spec\.ts$/;

/**
 * Blocked by default across every correctness project (issue #1106): `baseURL`
 * is always `localhost` here (`makeServer`, below), and ngsw treats a
 * localhost origin as a debug/dev context — `scheduleInitialization` skips the
 * idle scheduler and awaits the whole prefetch inline before answering the
 * FIRST fetch the worker intercepts. On any other origin the same prefetch is
 * scheduled on the idle callback and never blocks a request, so this is a
 * harness exposure, not one real listeners hit — but it is a real one for CI,
 * where that inline prefetch can apparently stall outright (see docs/e2e.md).
 * `offline.spec.ts` opts back to `'allow'` for the one describe that
 * genuinely needs a live worker.
 */
const SERVICE_WORKERS_BLOCKED = { serviceWorkers: 'block' } as const;

export default defineConfig({
  testDir: './tests',
  // Fails the run if anything rewrote the tracked fixtures (#1320).
  globalSetup: './fixture-guard.ts',
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
    // Not `on-first-retry`: it traced neither place a flake has been seen —
    // locally `retries` is 0, and in CI it traces the retry, which for an
    // order-dependent flake is the attempt that PASSES (#1116, #835, docs/e2e.md).
    trace: { mode: 'retain-on-failure', snapshots: true, screenshots: true, sources: false },
    screenshot: 'only-on-failure',
  },
  // Screenshot assertions (the `tv` project). Animations are frozen by default;
  // the ratio and threshold absorb a different Chromium build's anti-aliasing
  // — the baselines are Linux renderings with the fonts pinned by
  // tests/tv-build/tv-test.ts, so a layout change still fails and a
  // rasteriser nudge does not (docs/e2e.md "The TV bundle in Chromium").
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.03, threshold: 0.3, caret: 'hide' },
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
    : [
        makeServer(PORT, dataDir, E2E_MUSIC_DIR),
        makeServer(ONBOARDING_PORT, onboardingDataDir, ONBOARDING_MUSIC_DIR),
        makeServer(TV_PORT, tvDataDir, TV_BUILD_MUSIC_DIR, { NICOTIND_WEB_DIST: TV_DIST }),
      ],
});

/**
 * The correctness projects. `onboarding` runs the setup-wizard spec against the
 * dedicated never-seeded server (no `storageState`, no `setup` dependency) so it
 * sees `needsSetup: true`; the rest of the suite runs against the seeded server.
 * The onboarding project is skipped in external mode — you must never drive the
 * setup wizard against a real instance. See `SERVICE_WORKERS_BLOCKED` above for
 * why the projects also carry `serviceWorkers: 'block'` (issue #1106) — the
 * `tv` project included, as its server is a `localhost` origin too.
 */
function correctnessProjects(): PlaywrightTestConfig['projects'] {
  const projects: NonNullable<PlaywrightTestConfig['projects']> = [
    // Anchored on the directory separator: `tv-auth.setup.ts` must not match.
    { name: 'setup', testMatch: /\/auth\.setup\.ts$/ },
    {
      name: 'chromium',
      // The correctness suite never runs the playground flows, the onboarding
      // wizard needs a never-seeded server (its own project below), and the TV
      // bundle has its own server and project.
      testIgnore: [PLAYGROUND_RE, /onboarding\.spec\.ts/, TV_BUILD_RE],
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/admin.json',
        ...SERVICE_WORKERS_BLOCKED,
      },
      dependencies: ['setup'],
    },
  ];
  if (!externalBaseUrl) {
    projects.push({
      name: 'onboarding',
      testMatch: /onboarding\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${ONBOARDING_PORT}`,
        ...SERVICE_WORKERS_BLOCKED,
      },
    });
    // The real TV route tree in Chromium (#1136): the TV-configuration bundle on
    // its own server, at the viewport a 1080p Android TV gives the WebView
    // (960×540 CSS px at DPR 2). DPR 1 here keeps the committed baselines small;
    // the layout is the same. Spatial navigation and hardware Back are still
    // emulator-only (docs/e2e-tv-emulator.md) — pixels and geometry are not.
    const tvBaseURL = `http://localhost:${TV_PORT}`;
    projects.push(
      { name: 'tv-setup', testMatch: /\/tv-auth\.setup\.ts$/, use: { baseURL: tvBaseURL } },
      {
        name: 'tv',
        testMatch: TV_BUILD_RE,
        use: {
          ...devices['Desktop Chrome'],
          viewport: { width: 960, height: 540 },
          deviceScaleFactor: 1,
          baseURL: tvBaseURL,
          storageState: '.auth/tv-admin.json',
          ...SERVICE_WORKERS_BLOCKED,
        },
        dependencies: ['tv-setup'],
      },
    );
  }
  return projects;
}

/** Build a managed server config on the given port + throwaway data and music dirs. */
type WebServer = Extract<NonNullable<PlaywrightTestConfig['webServer']>, { command: string }>;

function makeServer(
  port: string,
  dir: string,
  musicDir: string,
  extraEnv: Record<string, string> = {},
): WebServer {
  return {
    command: 'bun run src/main.ts',
    cwd: repoRoot,
    url: `http://localhost:${port}/api/health`,
    // Never reuse, even locally. This config wipes `dataDir` at eval time (above),
    // so a server left running by a previous invocation would still hold the now
    // unlinked SQLite file open and serve stale/empty data — reuse and the wipe are
    // mutually incoherent. That combination silently poisons a run and surfaces far
    // from its cause (a seeded-library assertion failing in `auth.setup`, skipping
    // the whole suite). Failing loudly on a busy port is the better trade.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NICOTIND_PORT: port,
      NICOTIND_MODE: 'external', // never spawn sub-services
      NICOTIND_LIDARR_URL: 'http://127.0.0.1:1', // isolate from a real Lidarr
      NICOTIND_DATA_DIR: dir,
      NICOTIND_MUSIC_DIR: musicDir,
      // The silent-FLAC fixtures are ~30s; without this the radio pool's 60s
      // minimum-duration floor (issue #583) would empty every e2e radio queue.
      NICOTIND_RADIO_MIN_DURATION: '0',
      // A context torn down by Playwright fires no `pagehide`, so the session
      // its tab held lingers for the grace; at 15 s the next spec's first play
      // would drive a dead output. Short enough to clear between specs, long
      // enough that a reload inside one spec still reconnects within it.
      NICOTIND_PLAYBACK_GRACE_MS: '2000',
      ...extraEnv,
    },
  };
}
