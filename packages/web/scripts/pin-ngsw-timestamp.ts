/**
 * Make `dist/ngsw.json` byte-identical across builds of the same commit.
 *
 * Angular's service-worker manifest carries `timestamp: Date.now()`
 * (`@angular/service-worker`'s config generator). `cap sync` copies the whole
 * web bundle into the Android APK, so that one field made every APK of a given
 * commit differ — which is precisely what F-Droid's reproducible-build check
 * compares. Measured on v0.8.5: of 658 APK entries, `assets/public/ngsw.json`
 * was the ONLY difference between the published APK and a clean rebuild.
 *
 * Runs as the web package's `postbuild`, so every consumer of the web build
 * gets it without knowing about it — CI, Docker, desktop packaging, the e2e
 * lanes, and F-Droid's own recipe, which invokes the same package script.
 *
 * Behaviour-neutral for the PWA: `ngsw-worker.js` reads `timestamp` only under
 * `applicationMaxAge`, which `ngsw-config.json` does not set. Pinning it makes
 * identical inputs hash identical, which is the point.
 *
 * Deliberately dependency-free (node builtins only): Docker's web-builder stage
 * copies just `packages/web` and has no git, so anything else would not resolve.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 1980-01-01T00:00:00Z — the zip epoch AGP already stamps on every APK entry,
 * so a build with no commit to date from lands on a value the archive already
 * uses rather than inventing one.
 */
export const FALLBACK_EPOCH_SECONDS = 315_532_800;

export type EpochSource = 'SOURCE_DATE_EPOCH' | 'git' | 'fallback';

/**
 * Pick the build timestamp, preferring the same source F-Droid's buildserver
 * uses. `SOURCE_DATE_EPOCH` is the cross-ecosystem convention and fdroidserver
 * sets it from `git log -1 --format=%ct`; deriving it ourselves the same way
 * means our CI and their rebuild agree without coordinating.
 *
 * A malformed `SOURCE_DATE_EPOCH` throws rather than falling through: silently
 * ignoring it would produce a build that looks pinned and is not.
 */
export function resolveSourceDateEpoch(
  env: Record<string, string | undefined>,
  gitHeadCommitTime: () => number | null,
): { seconds: number; source: EpochSource } {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(
        `SOURCE_DATE_EPOCH must be a non-negative integer number of seconds, got ${JSON.stringify(raw)}.`,
      );
    }
    return { seconds: Number(raw.trim()), source: 'SOURCE_DATE_EPOCH' };
  }
  const git = gitHeadCommitTime();
  if (git !== null) return { seconds: git, source: 'git' };
  return { seconds: FALLBACK_EPOCH_SECONDS, source: 'fallback' };
}

/**
 * Replace the manifest's `timestamp` with a fixed value, changing nothing else.
 *
 * Throws unless the field appears exactly once. A zero-match would mean Angular
 * changed the manifest shape and this pin had quietly become dead config — the
 * failure mode that matters, because the build keeps succeeding while
 * reproducibility goes away.
 */
export function pinManifestTimestamp(manifestText: string, epochSeconds: number): string {
  const pattern = /("timestamp"\s*:\s*)\d+/g;
  const matches = manifestText.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `expected exactly one "timestamp" field in ngsw.json, found ${matches?.length ?? 0}. ` +
        'Angular changed the manifest shape — update pin-ngsw-timestamp.ts rather than ' +
        'removing it, or the build silently stops being reproducible.',
    );
  }
  return manifestText.replace(pattern, `$1${epochSeconds * 1000}`);
}

/** HEAD's commit time, or null wherever git cannot answer (Docker has no .git). */
function gitHeadCommitTime(cwd: string): number | null {
  const res = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  const n = Number((res.stdout ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `outputPath` is either a string or `{ base, browser }` (Angular 17+). */
export function resolveBrowserOutputDir(outputPath: unknown, webRoot: string): string {
  if (typeof outputPath === 'string') return resolve(webRoot, outputPath);
  if (outputPath && typeof outputPath === 'object') {
    const { base, browser } = outputPath as { base?: string; browser?: string };
    if (typeof base === 'string') return resolve(webRoot, base, browser ?? 'browser');
  }
  throw new Error(`could not read outputPath from angular.json: ${JSON.stringify(outputPath)}`);
}

function main(): void {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const angular = JSON.parse(readFileSync(join(webRoot, 'angular.json'), 'utf8')) as {
    projects: Record<string, { architect: { build: { options: { outputPath?: unknown } } } }>;
  };
  const project = angular.projects['nicotind-web'];
  if (!project) throw new Error('angular.json has no "nicotind-web" project.');
  const outDir = resolveBrowserOutputDir(project.architect.build.options.outputPath, webRoot);

  const manifest = join(outDir, 'ngsw.json');
  const worker = join(outDir, 'ngsw-worker.js');

  if (!existsSync(manifest)) {
    // A build without the service worker (the `development` configuration, or a
    // `--output-path` elsewhere) legitimately has no manifest. But a worker with
    // no manifest means the build half-ran, and silently skipping would hide it.
    if (existsSync(worker)) {
      throw new Error(`${worker} exists but ${manifest} does not — the web build is incomplete.`);
    }
    console.log('ngsw.json: absent (no service worker in this build) — nothing to pin.');
    return;
  }

  const { seconds, source } = resolveSourceDateEpoch(process.env, () => gitHeadCommitTime(webRoot));
  writeFileSync(manifest, pinManifestTimestamp(readFileSync(manifest, 'utf8'), seconds));
  console.log(`ngsw.json: timestamp pinned to ${seconds} (${source}).`);
}

if (import.meta.main) main();
