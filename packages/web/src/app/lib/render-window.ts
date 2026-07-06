import { signal, computed, type Signal } from '@angular/core';

/**
 * A render-only window over a reactive list. The full `source` stays intact (so
 * whole-list actions like play-all / select-all / download still work), while
 * only the first `count` items are exposed for the template `@for` to mount.
 *
 * This is the fix for large views in a zoneless app where DOM node *volume* —
 * not change detection — is the bottleneck: a 5000-song genre or a full artists
 * list renders in fixed-size pages grown by an IntersectionObserver sentinel,
 * capping mounted nodes without paginating the underlying data.
 */
export interface RenderWindow<T> {
  /** The currently-mounted slice: `source.slice(0, count)`. */
  visible: Signal<T[]>;
  /** True while the window is smaller than the source (show the sentinel). */
  hasMore: Signal<boolean>;
  /** Grow the window by one page. */
  showMore(): void;
  /** Collapse back to the first page (e.g. on filter/sort change). */
  reset(): void;
}

export function createRenderWindow<T>(source: Signal<T[]>, pageSize = 100): RenderWindow<T> {
  const count = signal(pageSize);
  return {
    visible: computed(() => source().slice(0, count())),
    hasMore: computed(() => count() < source().length),
    showMore: () => count.update((c) => c + pageSize),
    reset: () => count.set(pageSize),
  };
}
