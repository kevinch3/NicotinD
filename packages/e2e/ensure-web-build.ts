import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Build `@nicotind/web` before Playwright boots the managed server.
 *
 * why (issue #253): the managed `webServer` runs `bun run src/main.ts`, and Hono
 * serves the **prebuilt** `packages/web/dist` — there is no dev server and no
 * watch. Nothing in the `bun run e2e` chain built it, so editing anything under
 * `packages/web/src` and then running the documented command silently exercised
 * the *previous* bundle.
 *
 * It failed in the most misleading possible direction: a spec written for a fix
 * you just made reports the **pre-fix** behaviour as the actual value, which
 * reads exactly like the fix not working. Real cost paid during the #233
 * regression spec — several minutes re-reading correct code.
 *
 * Called at **config-eval time**, mirroring the fresh-DB `rmSync` in
 * playwright.config.ts and for the same reason: it must happen before Playwright
 * launches the webServer, so a `globalSetup` hook would be too late.
 *
 * Living in the config rather than the root `e2e` script means every entry point
 * is covered by construction — `bun run e2e`, `bun run --filter @nicotind/e2e
 * test`, a bare `playwright test` typed inside the package, `--ui`, `--headed`.
 * Fixing only the root script would have left the form docs/e2e.md actually
 * documents still broken.
 */
export function ensureWebBuild(): void {
  // Playwright re-evaluates the config file inside every worker process, so a
  // bare call here builds once per worker (measured: 3x on a single-spec run).
  // Only the main process should build — by the time a worker loads the config
  // the server is already up and the bundle it serves is fixed anyway.
  if (process.env.TEST_WORKER_INDEX !== undefined) return;

  // Pointed at an already-running instance (prod smoke): there is no local
  // bundle in play, and building would be both useless and surprising.
  if (process.env.E2E_BASE_URL) return;

  // Escape hatch for re-running one spec repeatedly while debugging.
  if (process.env.E2E_SKIP_BUILD) {
    console.log('[e2e] E2E_SKIP_BUILD set — serving the existing packages/web/dist');
    return;
  }

  console.log('[e2e] building @nicotind/web (set E2E_SKIP_BUILD=1 to skip)…');
  const built = spawnSync('bun', ['run', '--filter', '@nicotind/web', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Fail loudly. Continuing would run the whole suite against a stale bundle —
  // exactly the failure this exists to remove.
  if (built.status !== 0) {
    throw new Error(
      `[e2e] web build failed (exit ${built.status ?? 'signal ' + built.signal}). ` +
        'Fix the build, or set E2E_SKIP_BUILD=1 to run against the existing dist.',
    );
  }
}
