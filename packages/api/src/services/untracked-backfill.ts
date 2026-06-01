/**
 * Backfill `completed_downloads.relative_path` for rows that predate the library
 * organizer (the usage analysis found ~2,226 such rows). Those files exist on
 * disk but have no recorded path, so they're invisible to auto-playlist, album
 * deletion and tombstoning. This walks the music dir, indexes files by basename,
 * and fills in the path for any unambiguous match.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { AUDIO_EXTS } from './audio-tags.js';

const log = createLogger('untracked-backfill');

export interface BackfillResult {
  /** Rows that had exactly one on-disk match and were (or would be) filled in. */
  matched: number;
  /** Rows whose basename matched multiple files — skipped to avoid guessing. */
  ambiguous: number;
  /** Rows with no matching file on disk. */
  unresolved: number;
}

/** Recursively map lowercased audio-file basename → relative paths under root. */
export function buildBasenameIndex(musicDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && AUDIO_EXTS.has(extname(name).toLowerCase())) {
        const key = name.toLowerCase();
        const rel = relative(musicDir, full).replace(/\\/g, '/');
        const list = index.get(key);
        if (list) list.push(rel);
        else index.set(key, [rel]);
      }
    }
  };

  walk(musicDir);
  return index;
}

/**
 * Fill in relative_path for completed_downloads rows that lack one, matching by
 * basename against files on disk. Dry-run unless `apply` is true.
 */
export function backfillRelativePaths(
  db: Database,
  musicDir: string,
  opts: { apply?: boolean } = {},
): BackfillResult {
  const apply = opts.apply ?? false;
  const index = buildBasenameIndex(musicDir);
  const result: BackfillResult = { matched: 0, ambiguous: 0, unresolved: 0 };

  const rows = db
    .query(
      `SELECT transfer_key AS transferKey, basename FROM completed_downloads WHERE relative_path IS NULL`,
    )
    .all() as Array<{ transferKey: string; basename: string }>;

  for (const row of rows) {
    const candidates = index.get(row.basename);
    if (!candidates || candidates.length === 0) {
      result.unresolved++;
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous++;
      continue;
    }
    result.matched++;
    if (apply) {
      db.run('UPDATE completed_downloads SET relative_path = ? WHERE transfer_key = ?', [
        candidates[0],
        row.transferKey,
      ]);
    }
  }

  log.info(result, apply ? 'Backfill applied' : 'Backfill dry run');
  return result;
}
