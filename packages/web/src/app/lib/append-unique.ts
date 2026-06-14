/**
 * Appends `incoming` items to `existing`, dropping any whose `id` is already
 * present. Offset-based pagination over a live dataset (new albums appearing as
 * downloads complete, server-side filtering) can hand back a page that overlaps
 * what's already loaded; appending blindly would render the same album twice.
 * Defensive belt-and-suspenders on top of the server-side pagination fix.
 */
export function appendUnique<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));
  return fresh.length === incoming.length ? [...existing, ...incoming] : [...existing, ...fresh];
}
