#!/usr/bin/env bun
/**
 * The hunt-query and title-match files exist twice and must stay identical (#1874).
 *
 *   bun run check:addon-sdk-sync
 *
 * WHY: `kevinch3/nicotind-slskd-addon` vendors its own `packages/addon-sdk`.
 * That copy is what actually searches Soulseek; this repo's copy only feeds the
 * web hunt modal's list of "queries this hunt fires". A change merged only here
 * makes the UI describe searches prod never runs, with every check green. #1870
 * needed two PRs (#1871 + addon #30) for exactly this reason, and nothing would
 * have caught forgetting the second.
 *
 * WHEN IT BLOCKS: only when this branch changes one of the shared files and the
 * addon's `main` does not already carry the same bytes. That is also the deploy
 * order that works: the addon's `main` builds `:latest`, and Deploy host pulls it,
 * so merging core first would ship the old addon. Merge the addon PR, then this.
 *
 * WHEN IT ONLY WARNS: drift on a branch that does not touch the files (the addon
 * moved first). Failing there would redden master for every unrelated PR until
 * someone ports the change, which trains people to ignore red; the warning names
 * the file instead. An unreachable GitHub warns too, unless the branch touches a
 * shared file: then a pass would be a guess.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ADDON_REPO = 'kevinch3/nicotind-slskd-addon';
export const ADDON_REF = 'main';

/** Paths that are identical in both repos, relative to each repo's root. */
export const SHARED_FILES: readonly string[] = [
  'packages/addon-sdk/src/hunt-queries.ts',
  'packages/addon-sdk/src/title-match.ts',
];

export interface FileState {
  path: string;
  /** Changed on this branch (vs its merge base with master, or uncommitted). */
  touched: boolean;
  /** The addon's copy, or null when it could not be fetched. */
  addon: string | null;
  local: string;
}

export interface Verdict {
  ok: boolean;
  lines: string[];
}

export function syncVerdict(files: readonly FileState[]): Verdict {
  const lines: string[] = [];
  let ok = true;
  for (const f of files) {
    if (f.addon === null) {
      if (f.touched) {
        ok = false;
        lines.push(`✗ ${f.path}: changed here, and ${ADDON_REPO}@${ADDON_REF} could not be read`);
      } else {
        lines.push(`! ${f.path}: ${ADDON_REPO}@${ADDON_REF} could not be read; not compared`);
      }
      continue;
    }
    if (f.addon === f.local) continue;
    if (f.touched) {
      ok = false;
      lines.push(
        `✗ ${f.path}: differs from ${ADDON_REPO}@${ADDON_REF}. Land the same change in the addon ` +
          `first (its main builds the image prod pulls), then this PR.`,
      );
    } else {
      lines.push(
        `! ${f.path}: ${ADDON_REPO}@${ADDON_REF} has moved on; port its change here so the hunt ` +
          `modal describes what prod searches.`,
      );
    }
  }
  return { ok, lines };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Files this branch changes: commits since the merge base with master, plus the worktree. */
function changedPaths(): Set<string> {
  const base = process.env.ADDON_SDK_SYNC_BASE ?? 'origin/master';
  const out = new Set<string>();
  try {
    const mergeBase = git(['merge-base', base, 'HEAD']);
    for (const p of git(['diff', '--name-only', mergeBase]).split('\n')) if (p) out.add(p);
  } catch {
    // No such base (a shallow clone): fall back to uncommitted changes only.
    for (const p of git(['diff', '--name-only', 'HEAD']).split('\n')) if (p) out.add(p);
  }
  return out;
}

async function fetchAddonFile(path: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${ADDON_REPO}/${ADDON_REF}/${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const changed = changedPaths();
  const files = await Promise.all(
    SHARED_FILES.map(async (path) => ({
      path,
      touched: changed.has(path),
      addon: await fetchAddonFile(path),
      local: readFileSync(path, 'utf8'),
    })),
  );
  const { ok, lines } = syncVerdict(files);
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
  console.log(
    lines.length
      ? `addon-sdk sync: ${lines.length} warning(s), nothing this branch changed is out of sync.`
      : `addon-sdk sync: ${SHARED_FILES.length} shared file(s) identical to ${ADDON_REPO}@${ADDON_REF}.`,
  );
}
