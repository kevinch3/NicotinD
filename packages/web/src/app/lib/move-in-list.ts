/**
 * Move one item within a list, returning a new array. Shared by the Now Playing
 * queue's drag-reorder and the track-info sheet's genre-chip reorder (issue
 * #684) — the second drag-reorder surface is the point at which two identical
 * splice pairs would have started drifting.
 *
 * Out-of-range indices return the list unchanged rather than throwing: a drop
 * event can name a row that a concurrent update already removed.
 */
export function moveInList<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return [...list];
  if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved as T);
  return next;
}
