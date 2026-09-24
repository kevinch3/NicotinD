import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = dirname(fileURLToPath(import.meta.url));

/** The git-tracked fixture tree. No managed server is ever pointed at it (#1320). */
export const FIXTURES_DIR = resolve(e2eRoot, 'fixtures');
export const TRACKED_MUSIC_DIR = join(FIXTURES_DIR, 'music');

/**
 * Per-server throwaway copies of `fixtures/music`. The server writes into its
 * music dir — lyrics and analysis tags, deletes, landed downloads — so each one
 * gets its own copy, made fresh at config-eval time. Specs that touch the disk
 * use `E2E_MUSIC_DIR`, the main server's copy.
 */
export const E2E_MUSIC_DIR = resolve(e2eRoot, '.tmp-music');
export const ONBOARDING_MUSIC_DIR = resolve(e2eRoot, '.tmp-music-onboarding');
export const TV_BUILD_MUSIC_DIR = resolve(e2eRoot, '.tmp-music-tvbuild');

/** Replace `dest` with a fresh copy of the tracked music fixtures. */
export function copyMusicFixtures(dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(TRACKED_MUSIC_DIR, dest, { recursive: true });
}

/** sha256 of every file under `root`, keyed by its path relative to `root`. */
export function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const entries = readdirSync(root, { recursive: true, withFileTypes: true, encoding: 'utf8' });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    out.set(relative(root, abs), createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

/** Paths added, removed or rewritten between two `hashTree` snapshots, sorted. */
export function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [p, h] of before) if (after.get(p) !== h) changed.add(p);
  for (const p of after.keys()) if (!before.has(p)) changed.add(p);
  return [...changed].sort();
}
