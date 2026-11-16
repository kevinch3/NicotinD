/**
 * Groups of a song menu, in the order they appear (#2006). A separator is drawn
 * wherever the group changes from one row to the next.
 */
export const MENU_GROUPS = ['play', 'goto', 'keep', 'info', 'feedback', 'role', 'remove'] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/**
 * Whether row `index` begins a new group, so a separator goes above it. Never
 * the first row. Rows with no group (a page's `extraActions`) count as one
 * group of their own, which puts a separator between them and what came before.
 */
export function startsGroup(actions: readonly { group?: MenuGroup }[], index: number): boolean {
  if (index <= 0 || index >= actions.length) return false;
  return (actions[index]!.group ?? null) !== (actions[index - 1]!.group ?? null);
}
