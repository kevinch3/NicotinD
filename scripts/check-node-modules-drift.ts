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
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseBunLock, resolveKey, versionOf, type BunLock } from './check-audit.js';

export interface DriftFinding {
  workspace: string;
  name: string;
  lockedVersion: string;
  linkedVersion: string;
}

/** A package installed in the tree that `bun.lock` does not mention at all. */
export interface OrphanFinding {
  workspace: string;
  name: string;
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

/**
 * Packages present in the tree that `bun.lock` does not mention **at all**.
 *
 * `findDrift` above iterates the LOCKFILE and asks what each entry resolves to
 * on disk, so a package that left the lockfile is never iterated and is
 * invisible to it by construction. That is the other direction, and it is not
 * hypothetical: `bun install` does not prune a package removed from the
 * lockfile, so the directory survives a full install on a fully up-to-date
 * checkout (#1266).
 *
 * Measured when this was written — five survivors, each from a dependency
 * removed months apart: `@capacitor/assets` (#1259), `@capacitor/barcode-scanner`
 * (replaced by zxing), `@tailwindcss/vite`, `@types/react-dom` and
 * `@vitejs/plugin-react`. The first of those kept `sharp@0.32.6` reachable, so
 * `check:install-scripts` reported an unreviewed install hook on **every
 * branch**, for a package no lockfile has pinned since #1259. A gate that is
 * permanently red is one people stop reading.
 *
 * **The predicate is lockfile MEMBERSHIP, not declared-dependency membership.**
 * Comparing against each workspace's own `package.json` gives 41 false
 * positives here, because bun hoists plenty into the root `node_modules` that
 * the root does not declare. Asking "is this name in `lock.packages`?" is exact.
 */
export function findOrphans(
  lock: BunLock,
  listLinked: (dir: string) => Array<{ name: string; inStore: boolean }>,
): OrphanFinding[] {
  const known = new Set(Object.keys(lock.packages));
  const workspaceNames = new Set(
    Object.values(lock.workspaces)
      .map((w) => w.name)
      .filter((n): n is string => !!n),
  );

  const findings: OrphanFinding[] = [];
  for (const [dir, w] of Object.entries(lock.workspaces)) {
    for (const { name, inStore } of listLinked(dir)) {
      if (known.has(name) || workspaceNames.has(name)) continue;
      // Only store-backed links are orphans. A workspace-to-workspace symlink
      // resolves outside `.bun` and is not something `bun install` manages.
      if (!inStore) continue;
      findings.push({ workspace: w.name ?? dir, name });
    }
  }
  return findings;
}

/**
 * Every package linked under one workspace's `node_modules`, and whether it
 * resolves into bun's store.
 *
 * **Scope directories are symlinks in this layout**, so descending has to
 * happen regardless of `isSymbolicLink()` — guarding on it silently skips every
 * scoped package, which is how a first attempt at this reported zero orphans
 * while two sat on disk.
 */
function listLinkedOnDisk(root: string, dir: string): Array<{ name: string; inStore: boolean }> {
  const base = join(root, dir, 'node_modules');
  const out: Array<{ name: string; inStore: boolean }> = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return out; // nothing installed for this workspace
  }
  const record = (name: string, path: string): void => {
    try {
      out.push({ name, inStore: realpathSync(path).includes(`${sep}.bun${sep}`) });
    } catch {
      /* a broken link is not an orphan; it is a different problem */
    }
  };
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(base, entry.name);
    if (entry.name.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = readdirSync(full);
      } catch {
        continue;
      }
      for (const child of scoped) record(`${entry.name}/${child}`, join(full, child));
    } else {
      record(entry.name, full);
    }
  }
  return out;
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
  const orphans = findOrphans(lock, (dir) => listLinkedOnDisk(root, dir));

  // Print the denominator, not only the findings: "0 drifted, 0 orphaned" out
  // of a known number of workspaces is a different statement from a check that
  // silently looked at nothing.
  console.log(
    `node_modules drift: ${Object.keys(lock.workspaces).length} workspace(s) checked — ` +
      `${findings.length} version mismatch(es), ${orphans.length} orphaned package(s).`,
  );

  if (orphans.length) {
    console.error(
      `\n${orphans.length} package(s) in ${root} are installed but absent from bun.lock:\n`,
    );
    for (const o of orphans) console.error(`  ${o.workspace}: ${o.name}`);
    console.error(
      '\n`bun install` does NOT prune a package that left the lockfile, so these\n' +
        'survive a full install on an up-to-date checkout. They are not inert: an\n' +
        'orphan drags its own dependencies back into the tree, which is how\n' +
        '`check:install-scripts` reported sharp@0.32.6 on every branch for weeks\n' +
        'after #1259 removed the package that pulled it in.\n' +
        'Fix it in the MAIN checkout, not a worktree: delete the listed directories\n' +
        '(or `rm -rf node_modules packages/*/node_modules && bun install`), then\n' +
        're-run link-worktree.sh in every worktree that linked the stale tree.',
    );
    process.exit(1);
  }

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
