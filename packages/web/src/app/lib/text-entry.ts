/**
 * The one "is the user typing here?" guard (#1296): the pull-to-refresh
 * gesture refuses to start on these targets, and the global keyboard
 * shortcuts refuse to fire from them. A `<select>` is included because its
 * letters and arrows are type-ahead and option changes.
 */
export const TEXT_ENTRY_TARGETS =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"])';

export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(TEXT_ENTRY_TARGETS) !== null || el.isContentEditable === true;
}
