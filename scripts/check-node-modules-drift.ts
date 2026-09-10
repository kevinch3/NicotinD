/**
 * A worktree's node_modules is SHARED with the main checkout: link-worktree.sh
 * recreates each workspace's own `node_modules/<pkg>` symlinks pointing at
 * whatever `$MAIN/node_modules/.bun/<pkg>@<version>` they already resolve to.
 * Bun's store keeps every version it has ever installed side by side, and
 * `bun install` against an already-satisfied bun.lock reports "no changes"
 * without re-pointing a symlink that drifted onto a stale entry -- so the
 * store can hold both the locked version and a leftover older one, with the
 * workspace still linked to the leftover (#1088).
 *
 * This walks every workspace's direct dependencies, asks bun.lock what
 * version each SHOULD resolve to, and compares it to the version the
 * on-disk symlink actually resolves to. A mismatch means link-worktree.sh
 * is about to hand a fresh worktree a tree that will fail typecheck in a
 * way that looks like the branch's fault.
 *
 *   bun run scripts/check-node-modules-drift.ts [root]
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBunLock, resolveKey, versionOf, type BunLock } from './check-audit.js';

export interface DriftFinding {
  workspace: string;
  name: string;
  lockedVersion: string;
  linkedVersion: string;
}

/**
 * `.bun/hono@4.13.3/node_modules/hono` -> `4.13.3`. Scoped names are stored
 * with the `/` replaced by `+` (`@hono/zod-openapi` -> `@hono+zod-openapi@…`).
 * Returns null for anything not resolving into the `.bun` store -- a
 * workspace-to-workspace link (`@nicotind/core`) included.
 */
export function versionFromRealpath(name: string, realpath: string): string | null {
  const storeName = name.replace(/\//g, '+').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = realpath.match(new RegExp(`/\\.bun/${storeName}@([^/]+)/`));
  return match ? match[1]! : null;
}

/**
 * Compare what bun.lock pins for each workspace's direct dependency against
 * what `resolveLinked` reports is actually linked. Pure so the comparison
 * runs against a fabricated lock + stub in tests, without a real
 * node_modules tree.
 */
export function findDrift(
  lock: BunLock,
  resolveLinked: (dir: string, name: string) => string | null,
): DriftFinding[] {
  const workspaceNames = new Set(
    Object.values(lock.workspaces)
      .map((w) => w.name)
      .filter((n): n is string => !!n),
  );

  const findings: DriftFinding[] = [];
  for (const [dir, w] of Object.entries(lock.workspaces)) {
    const deps = { ...w.dependencies, ...w.devDependencies };
    for (const name of Object.keys(deps)) {
      if (workspaceNames.has(name)) continue; // workspace:* link, not a store entry

      const key = resolveKey(lock, '', name);
      const lockedVersion = key ? versionOf(lock.packages[key]) : null;
      if (!lockedVersion) continue; // unresolved -- check:audit's concern, not this one's

      const linkedVersion = resolveLinked(dir, name);
      if (linkedVersion && linkedVersion !== lockedVersion) {
        findings.push({ workspace: w.name ?? dir, name, lockedVersion, linkedVersion });
      }
    }
  }
  return findings;
}

/** What's actually linked on disk for one workspace's dependency, or null if unreadable. */
function resolveOnDisk(root: string, dir: string, name: string): string | null {
  try {
    return versionFromRealpath(name, realpathSync(join(root, dir, 'node_modules', name)));
  } catch {
    return null; // not installed here -- nothing to compare
  }
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? '.');
  const lock = parseBunLock(readFileSync(join(root, 'bun.lock'), 'utf8'));
  const findings = findDrift(lock, (dir, name) => resolveOnDisk(root, dir, name));

  if (findings.length) {
    console.error(
      `${findings.length} package(s) in ${root} are linked to a version bun.lock does not pin:\n`,
    );
    for (const f of findings) {
      console.error(
        `  ${f.workspace}: ${f.name} -> ${f.linkedVersion} (bun.lock pins ${f.lockedVersion})`,
      );
    }
    console.error(
      '\nnode_modules/.bun still holds the stale version next to the locked one, and\n' +
        '`bun install` reports "no changes" against an already-satisfied lockfile -- it\n' +
        "won't re-point a symlink that already resolves to *some* installed version.\n" +
        'Fix it in the MAIN checkout, not a worktree: `bun install --force` (or delete\n' +
        'the stale node_modules/.bun/<pkg>@<old-version> entries directly), then re-run\n' +
        'link-worktree.sh in every worktree that already linked the stale tree.',
    );
    process.exit(1);
  }
}
