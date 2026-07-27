import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Move an artist's curated data onto a new artist id (issue #305).
 *
 * why: artist ids are derived from the name, so the admin identity fix
 * (rename / merge-variant) mints a **new** id — and every artist-scoped side
 * table is keyed on the old one, with no FK to notice. The curator's portrait,
 * bio and genre decision were silently detached by the very action meant to
 * tidy their library.
 *
 * Measured on prod before the fix: **88 of 1011** artist artwork rows dead
 * (8.7 %), **2 of 140** uploaded portrait files orphaned, and 1 dead bio. The
 * two uploads are user work — somebody chose that image. (Artist-scoped genre
 * overrides measured 0 dead; they are keyed on the normalized NAME, so a rename
 * orphans them even though nothing is orphaned today — see CarryTarget.)
 *
 * Same class as the song-id churn already handled in `library-transcode.ts` and
 * `playlist-repoint.ts`; this is the artist-shaped version. It belongs at the
 * identity-fix call site because that is the only place that knows the old→new
 * mapping — a prune-time guess could not.
 *
 * **Never clobbers.** A merge lands on an artist that may already have its own
 * portrait/bio/genre, and the destination's curation is the more deliberate
 * choice (it was set on the surviving artist). Each move is skipped when the
 * target already has a value, so a merge is additive rather than destructive.
 */

const OVERRIDE_SUBDIR = 'artist-overrides';
const VARIANT_EXTS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

export interface CarryResult {
  artwork: boolean;
  overrideFile: boolean;
  meta: boolean;
  genreOverride: boolean;
}

/** Move the uploaded portrait file, if the source has one and the target doesn't. */
function carryOverrideFile(dataDir: string, fromId: string, toId: string): boolean {
  const dir = join(dataDir, OVERRIDE_SUBDIR);
  const targetHas = VARIANT_EXTS.some((e) => existsSync(join(dir, toId + e)));
  if (targetHas) return false;

  for (const ext of VARIANT_EXTS) {
    const src = join(dir, fromId + ext);
    if (!existsSync(src)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      renameSync(src, join(dir, toId + ext));
      return true;
    } catch {
      // A failed file move must not abort the identity fix — the DB rows are
      // the more important half and the upload can be re-done by hand.
      return false;
    }
  }
  return false;
}

export interface CarryTarget {
  /** sha1 artist ids — what `library_artwork` / `library_artist_meta` key on. */
  fromId: string;
  toId: string;
  /**
   * Normalized artist NAMES. `library_genre_overrides (scope='artist')` keys on
   * `normalizeArtistForGrouping(name)`, not on the id — verified against prod,
   * where the single such row is `key = "ana tijoux"`. A rename therefore moves
   * that key even when the id-keyed tables move too, so the two must be carried
   * on different keys.
   */
  fromKey?: string;
  toKey?: string;
}

/**
 * Carry artwork, the uploaded portrait, bio/links and the artist-scoped genre
 * override across an identity change. No-op when the ids are equal.
 */
export function carryArtistCuration(
  db: Database,
  dataDir: string | undefined,
  target: CarryTarget,
): CarryResult {
  const { fromId, toId, fromKey, toKey } = target;
  const result: CarryResult = {
    artwork: false,
    overrideFile: false,
    meta: false,
    genreOverride: false,
  };
  // A rename that normalises to the same id (an accent or case fix) keeps the
  // id, so there is nothing to move — and moving would delete then re-insert.
  if (!fromId || !toId || fromId === toId) return result;

  const moved = (sql: string, params: unknown[]): boolean =>
    Number(db.run(sql, params as never).changes ?? 0) > 0;

  // `UPDATE OR IGNORE` + the NOT EXISTS guard together express "never clobber":
  // the guard skips when the target already has a row, the OR IGNORE keeps a
  // racing/duplicate key from aborting the surrounding transaction.
  result.artwork = moved(
    `UPDATE OR IGNORE library_artwork SET id = ?
      WHERE id = ? AND kind = 'artist'
        AND NOT EXISTS (SELECT 1 FROM library_artwork t WHERE t.id = ? AND t.kind = 'artist')`,
    [toId, fromId, toId],
  );

  result.meta = moved(
    `UPDATE OR IGNORE library_artist_meta SET artist_id = ?
      WHERE artist_id = ?
        AND NOT EXISTS (SELECT 1 FROM library_artist_meta t WHERE t.artist_id = ?)`,
    [toId, fromId, toId],
  );

  // Keyed on the normalized NAME, not the id — see CarryTarget.
  if (fromKey && toKey && fromKey !== toKey) {
    result.genreOverride = moved(
      `UPDATE OR IGNORE library_genre_overrides SET key = ?
        WHERE scope = 'artist' AND key = ?
          AND NOT EXISTS (
            SELECT 1 FROM library_genre_overrides t WHERE t.scope = 'artist' AND t.key = ?)`,
      [toKey, fromKey, toKey],
    );
  }

  if (dataDir) result.overrideFile = carryOverrideFile(dataDir, fromId, toId);

  return result;
}
