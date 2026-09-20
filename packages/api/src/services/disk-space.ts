import { statfsSync } from 'node:fs';

/**
 * Free-space probing, in one place.
 *
 * `StatfsFn` and `freeBytes` had three identical copies — `library-import.service.ts`,
 * `migration-backup.ts` and `routes/system.ts` — and the type was already being
 * imported across module boundaries from whichever file happened to declare it,
 * which is the shape that precedes a fourth copy.
 *
 * It lives in `packages/api` rather than core on purpose: core is deliberately
 * free of `node:fs` so the Angular build can import it (see
 * `audio-extensions.ts`, which hand-rolls `extname` for exactly that reason),
 * and all three consumers are API-side.
 *
 * **Unknown is not full.** Every probe here returns `null` rather than `0` when
 * the filesystem cannot answer, and callers must treat that as "proceed". An
 * unreadable `statfs` blocking an upgrade was the failure that established this
 * convention (`migration-backup.test.ts`), and a preflight that fails closed on
 * a container filesystem it cannot stat is worse than no preflight at all.
 *
 * → docs/library-import.md
 */

/** The subset of `node:fs` statfs we use; injectable so tests skip the real FS. */
export type StatfsFn = (path: string) => { bsize: number; blocks: number; bavail: number };

/** Real `statfs`, as a `StatfsFn`. The cast is node's typing, not a widening. */
export const realStatfs: StatfsFn = statfsSync as unknown as StatfsFn;

/**
 * Bytes available to an unprivileged writer at `path`, or `null` when the
 * filesystem cannot be probed — a missing path, a permission error, a container
 * mount that does not implement it.
 *
 * `bavail`, not `bfree`: the difference is the reserved superuser block pool,
 * and a backfill is not root.
 */
export function freeBytes(path: string, statfs: StatfsFn = realStatfs): number | null {
  try {
    const st = statfs(path);
    const n = st.bavail * st.bsize;
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface HeadroomCheck {
  /** False only when the probe answered AND the answer is too small. */
  sufficient: boolean;
  /** Free bytes, or `null` when the filesystem could not be probed. */
  free: number | null;
  /** What the caller said it needs, margin included. */
  required: number;
}

/**
 * Whether `path` has room for `required` bytes plus `margin`.
 *
 * Fails **open**: an unprobeable filesystem reports `sufficient: true` with
 * `free: null`, so a caller that wants to log "proceeding without a headroom
 * check" can tell that case from a genuine pass by looking at `free`.
 */
export function checkHeadroom(
  path: string,
  required: number,
  opts: { margin?: number; statfs?: StatfsFn } = {},
): HeadroomCheck {
  const total = Math.max(0, required) + Math.max(0, opts.margin ?? 0);
  const free = freeBytes(path, opts.statfs ?? realStatfs);
  return { sufficient: free === null || free >= total, free, required: total };
}
