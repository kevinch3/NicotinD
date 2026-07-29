import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('acquisition-repoint');

/**
 * Follow a file whose **extension** changed under its `acquisitions` row.
 *
 * why: provenance is keyed on `relative_path`, so replacing a track with a
 * different-format copy of the same recording (a re-download at better quality,
 * a manual re-rip) leaves the old row pointing at a path that no longer exists
 * while the live file carries no provenance at all. `library-transcode.ts`
 * already re-points these rows when lossless→opus changes the path, so the
 * mechanism exists — it just only covers the transcode path.
 *
 * Measured on prod (issue #313): of 4,586 orphaned rows, 435 share a stem with
 * a live song (dominated by `opus → mp3`, 331), and **17** of those are the only
 * surviving provenance for that live song. The other 418 are superseded history
 * — the live file already has its own row — and are left alone.
 *
 * This is deliberately **not** a prune. It recovers rows rather than deleting
 * them, which is also what makes a future `acquisitions` prune safe: without it,
 * sweeping orphans would silently destroy the provenance of 17 live tracks while
 * reporting reclaimed space.
 */

export interface AcquisitionRepointResult {
  /** Rows moved onto the surviving file for the same recording. */
  repointed: number;
  /** Stem-matched rows deliberately left alone (target already has provenance). */
  skippedCovered: number;
  /** Stem-matched rows left alone because the stem maps to more than one song. */
  skippedAmbiguous: number;
}

/** Strip a single trailing file extension. `a/b.opus` → `a/b`. */
function stem(path: string): string {
  return path.replace(/\.[^./]+$/, '');
}

/**
 * Re-point orphaned `acquisitions` rows onto the live file for the same
 * recording, matched by path stem.
 *
 * Two guards, both required — a wrong re-point attributes one track's download
 * to a different file, which is worse than the missing provenance it replaces:
 *
 * - **The stem must map to exactly one live song.** Two live files sharing a
 *   stem (`.mp3` and `.flac` of the same track) give no basis to choose.
 * - **That song must have no provenance row of its own.** Otherwise the orphan
 *   is superseded history, and overwriting the newer row would replace a true
 *   record with an older one.
 *
 * Idempotent: a repointed row is no longer an orphan, so a second pass is a
 * no-op.
 */
export function repointOrphanedAcquisitions(db: Database): AcquisitionRepointResult {
  const result: AcquisitionRepointResult = {
    repointed: 0,
    skippedCovered: 0,
    skippedAmbiguous: 0,
  };

  let livePaths: string[];
  try {
    livePaths = (db.query<{ path: string }, []>('SELECT path FROM library_songs').all() ?? []).map(
      (r) => r.path,
    );
  } catch {
    return result; // schema-less DB (minimal test harness)
  }
  // An empty library can't tell us anything about where a file moved to.
  if (livePaths.length === 0) return result;

  let orphans: string[];
  try {
    orphans = (
      db
        .query<{ relative_path: string }, []>(
          `SELECT relative_path FROM acquisitions
           WHERE relative_path NOT IN (SELECT path FROM library_songs)`,
        )
        .all() ?? []
    ).map((r) => r.relative_path);
  } catch {
    return result;
  }
  if (orphans.length === 0) return result;

  const liveByStem = new Map<string, string[]>();
  for (const p of livePaths) {
    const s = stem(p);
    const bucket = liveByStem.get(s);
    if (bucket) bucket.push(p);
    else liveByStem.set(s, [p]);
  }

  const covered = new Set(
    (
      db.query<{ relative_path: string }, []>('SELECT relative_path FROM acquisitions').all() ?? []
    ).map((r) => r.relative_path),
  );

  const update = db.prepare(
    'UPDATE OR IGNORE acquisitions SET relative_path = ? WHERE relative_path = ?',
  );
  const tx = db.transaction(() => {
    for (const orphan of orphans) {
      const candidates = liveByStem.get(stem(orphan));
      if (!candidates) continue; // no live file for this recording — a real deletion
      if (candidates.length > 1) {
        result.skippedAmbiguous++;
        continue;
      }
      const target = candidates[0]!;
      if (covered.has(target)) {
        result.skippedCovered++;
        continue;
      }
      result.repointed += Number(update.run(target, orphan).changes ?? 0);
      // Keep the in-pass view honest: two orphans (say .flac and .opus) can
      // share one live target, and only the first may claim it.
      covered.add(target);
    }
  });
  tx();

  if (result.repointed > 0) log.info(result, 'repointed orphaned acquisition provenance');
  return result;
}
