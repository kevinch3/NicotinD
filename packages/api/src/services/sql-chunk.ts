/**
 * Chunking for `IN (...)` lookups.
 *
 * why: SQLite caps bound parameters (999 by default), and every scoped loader
 * added for the per-batch reclassify (#1026 follow-up) takes a caller-supplied
 * id list whose length is not bounded by anything the caller controls — an
 * import of a large folder reconciles hundreds of albums at once.
 */

/** Bound-parameter budget per statement, comfortably under SQLite's 999. */
export const SQL_PARAM_CHUNK = 500;

/** `?, ?, ?` for `n` bound parameters. */
export function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** Split `items` into runs of at most `size`. Empty input yields no chunks. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
