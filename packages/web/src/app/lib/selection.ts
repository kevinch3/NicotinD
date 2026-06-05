import { computed, signal } from '@angular/core';

/**
 * Page-local multi-select state for track lists. A DI-free factory (not a root
 * service) so each list page owns ephemeral selection that can't leak across
 * routes. Mirrors the codebase's "signals everywhere" convention.
 *
 * Usage: hold `selection = createSelection()` on the component, bind track rows
 * to `selectable`/`isSelected`/`toggle`, and render the selection bar while
 * `active()`. `exit()` always clears the ticked set.
 */
export function createSelection() {
  const active = signal(false);
  const ids = signal<Set<string>>(new Set());

  return {
    active,
    ids,
    count: computed(() => ids().size),

    isSelected(id: string): boolean {
      return ids().has(id);
    },

    toggle(id: string): void {
      ids.update((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },

    selectAll(all: string[]): void {
      ids.set(new Set(all));
    },

    enter(): void {
      active.set(true);
    },

    exit(): void {
      active.set(false);
      ids.set(new Set());
    },
  };
}

export type Selection = ReturnType<typeof createSelection>;
