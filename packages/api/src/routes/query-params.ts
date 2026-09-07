import type { Context } from 'hono';

/**
 * Read a bounded positive integer from the query string.
 *
 * `Math.min(Number(c.req.query('size') ?? 60), 200)` was the idiom at 12 sites,
 * and it has two failure modes that both reach SQLite as a bound parameter:
 *
 *  - **Non-numeric** — `Number('abc')` is `NaN`, `Math.min(NaN, 200)` is `NaN`,
 *    and `bun:sqlite` rejects `NaN` with `datatype mismatch`. No handler catches
 *    it, so `?size=abc` is an unhandled **500** that also reaches Sentry as an
 *    unknown 500 — a malformed query string becomes operator noise (issue #945).
 *  - **Negative** — passed straight through to `LIMIT`, which SQLite reads as
 *    *no limit*. `?count=-1` on a cap-10000 endpoint was an unbounded scan, and
 *    that is the more interesting half of the bug.
 *
 * One site already had the intended shape (`|| 200` after the `Number`), so this
 * was drift from a local convention rather than a missing one — and
 * `check:shared-helpers` exists to stop eleven more copies of it.
 *
 * Anything that is not a finite integer ≥ 1 yields `fallback`; the result is
 * always clamped to `max`.
 */
export function clampQueryInt(
  c: Context,
  name: string,
  opts: { fallback: number; max: number },
): number {
  const raw = c.req.query(name);
  const n = raw == null || raw.trim() === '' ? opts.fallback : Number(raw);
  if (!Number.isFinite(n)) return Math.min(opts.fallback, opts.max);
  const i = Math.trunc(n);
  if (i < 1) return Math.min(opts.fallback, opts.max);
  return Math.min(i, opts.max);
}
