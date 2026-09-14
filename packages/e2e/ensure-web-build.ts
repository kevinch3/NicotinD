import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Where `ng build --configuration tv --output-path dist-tv` lands the bundle
 * the `tv` project serves (`NICOTIND_WEB_DIST`, see playwright.config.ts).
 *
 * The `browser/` segment is not a choice: angular.json declares `outputPath`
 * as `{ base: 'dist', browser: '' }`, and a CLI `--output-path` can only be a
 * string, which replaces the whole object — so the builder falls back to its
 * default `browser/` subfolder. Keeping the flag on the command line rather
 * than adding a second output path to the `tv` configuration is deliberate:
 * that configuration is also what `bun run e2e:tv` and the Capacitor TV APK
 * build, and both expect it in `dist/`.
 */
export const TV_DIST = resolve(repoRoot, 'packages/web/dist-tv/browser');

/**
 * Build `@nicotind/web` — the phone/desktop bundle AND the TV-configuration
 * bundle — before Playwright boots the managed servers.
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
 * The TV bundle (#1136) has the same hazard with one twist: the TV route tree
 * is a **build-time** fork (`environment.tvBuild`), so it is not a stale copy
 * of the same code that would be served, it is a different application — the
 * one the `tv` project exists to render at all.
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
    console.log('[e2e] E2E_SKIP_BUILD set — serving the existing packages/web/dist and dist-tv');
    return;
  }

  build('@nicotind/web', ['run', '--filter', '@nicotind/web', 'build']);
  build('@nicotind/web (tv configuration)', [
    'run',
    '--filter',
    '@nicotind/web',
    'build',
    '--',
    '--configuration',
    'tv',
    '--output-path',
    'dist-tv',
  ]);
}

function build(label: string, args: string[]): void {
  console.log(`[e2e] building ${label} (set E2E_SKIP_BUILD=1 to skip)…`);
  const built = spawnSync('bun', args, { cwd: repoRoot, stdio: 'inherit' });

  // Fail loudly. Continuing would run the whole suite against a stale bundle —
  // exactly the failure this exists to remove.
  if (built.status !== 0) {
    throw new Error(
      `[e2e] ${label} build failed (exit ${built.status ?? 'signal ' + built.signal}). ` +
        'Fix the build, or set E2E_SKIP_BUILD=1 to run against the existing dist.',
    );
  }
}
