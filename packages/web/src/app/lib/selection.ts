import { computed, signal } from '@angular/core';

/**
 * Page-local multi-select state for track lists. A DI-free factory (not a root
 * service) so each list page owns ephemeral selection that can't leak across
 * routes. Mirrors the codebase's "signals everywhere" convention.
 *
 * Usage: hold `selection = createSelection()` on the component, bind track rows
 * to `selectable`/`isSelected`/`toggle` (or `toggleRange` for shift-click range
 * support), and render the selection bar while `active()`. `exit()` always
 * clears the ticked set.
 */
export function createSelection() {
  const active = signal(false);
  const ids = signal<Set<string>>(new Set());
  // Anchor for shift-click range selection — the last row the user clicked.
  let anchorId: string | null = null;

  function plainToggle(id: string): void {
    ids.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return {
    active,
    ids,
    count: computed(() => ids().size),

    isSelected(id: string): boolean {
      return ids().has(id);
    },

    toggle(id: string): void {
      plainToggle(id);
      anchorId = id;
    },

    /**
     * Toggle with shift-click range support. When `shiftKey` is held and a prior
     * anchor exists in `orderedIds`, every row between the anchor and `id`
     * (inclusive) is set to match `id`'s new state. Otherwise a plain toggle.
     * `orderedIds` must be the list as currently displayed.
     */
    toggleRange(id: string, orderedIds: string[], shiftKey: boolean): void {
      if (shiftKey && anchorId !== null && anchorId !== id) {
        const a = orderedIds.indexOf(anchorId);
        const b = orderedIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [start, end] = [Math.min(a, b), Math.max(a, b)];
          const range = orderedIds.slice(start, end + 1);
          ids.update((s) => {
            const n = new Set(s);
            const shouldSelect = !s.has(id);
            for (const rid of range) {
              if (shouldSelect) n.add(rid);
              else n.delete(rid);
            }
            return n;
          });
          anchorId = id;
          return;
        }
      }
      plainToggle(id);
      anchorId = id;
    },

    selectAll(all: string[]): void {
      ids.set(new Set(all));
    },

    enter(): void {
      active.set(true);
      anchorId = null;
    },

    exit(): void {
      active.set(false);
      ids.set(new Set());
      anchorId = null;
    },
  };
}

export type Selection = ReturnType<typeof createSelection>;
