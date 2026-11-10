/**
 * Remove build-time tooling a production install still pulls in (#1810).
 *
 * `@sentry/node` lists `@sentry/bundler-plugins` as a regular dependency, and
 * that brings Sentry's CLI (`sentry`, FSL-1.1-Apache-2.0, not open source).
 * Only `@sentry/node`'s `bundler-plugin/*` subpaths import it, and nothing at
 * runtime does, so the image and the desktop backend ship without both.
 * → docs/licensing.md
 *
 * Handles bun's isolated store (`node_modules/.bun/<name>@<ver>`, linked in
 * by symlinks) and the hoisted layout (`node_modules/<name>`).
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_TOOLING = ['@sentry/bundler-plugins', 'sentry'] as const;

/** The isolated store's directory prefix for a package: `@a/b` → `@a+b@`. */
const storePrefix = (name: string) => `${name.replace('/', '+')}@`;

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `node_modules` directory under `root`, without following symlinks. */
function nodeModulesDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') out.push(path);
      walk(path);
    }
  };
  if (isDir(root)) walk(root);
  return out;
}

/** Delete `names` from the install at `root`; returns what it removed, relative to `root`. */
export function pruneBuildTooling(
  root: string,
  names: readonly string[] = BUILD_TOOLING,
): string[] {
  const removed: string[] = [];
  const rm = (path: string) => {
    rmSync(path, { recursive: true, force: true });
    removed.push(path.slice(root.length + 1));
  };
  for (const nm of nodeModulesDirs(root)) {
    if (!exists(nm)) continue;
    const store = join(nm, '.bun');
    if (isDir(store)) {
      for (const entry of readdirSync(store)) {
        if (names.some((n) => entry.startsWith(storePrefix(n)))) rm(join(store, entry));
      }
    }
    for (const name of names) {
      if (exists(join(nm, name))) rm(join(nm, name));
    }
  }
  return removed.sort();
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const removed = pruneBuildTooling(root);
  if (removed.length === 0) {
    console.error(`prune-build-tooling: none of ${BUILD_TOOLING.join(', ')} found under ${root}`);
    process.exit(1);
  }
  for (const r of removed) console.log(`pruned ${r}`);
}
