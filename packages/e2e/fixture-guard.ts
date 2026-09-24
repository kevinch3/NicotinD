import { FIXTURES_DIR, diffTrees, hashTree } from './fixture-music.js';

/**
 * Global setup: snapshot the tracked `fixtures/` tree; the returned teardown
 * fails the run if anything changed it (#1320). A server or spec writing into
 * the committed fixtures makes the next run start from different bytes and
 * invites a `git add -A` of a mutated binary — so it is a red run, not a
 * `git status` someone may or may not read.
 */
export default function fixtureGuard(): () => void {
  return snapshotGuard(FIXTURES_DIR);
}

/** Snapshot `root` now; the returned check throws if its files changed since. */
export function snapshotGuard(root: string): () => void {
  const before = hashTree(root);
  return () => {
    const changed = diffTrees(before, hashTree(root));
    if (changed.length > 0) {
      throw new Error(
        `The e2e run modified the tracked fixtures under packages/e2e/fixtures (#1320):\n` +
          changed.map((p) => `  ${p}`).join('\n') +
          `\nEvery managed server must run on a throwaway copy (fixture-music.ts). ` +
          `Restore with: git checkout -- packages/e2e/fixtures`,
      );
    }
  };
}
