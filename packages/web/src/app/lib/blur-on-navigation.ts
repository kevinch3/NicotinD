/**
 * Close the software keyboard through its normal path before a navigation
 * destroys the focused field (#1635, docs/web-ui.md "Keyboard and navigation").
 */

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function isTextEntry(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return (
    el instanceof HTMLInputElement &&
    !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'image'].includes(el.type)
  );
}

/**
 * Blur the focused text field when the navigation leaves the page. A change of
 * query or fragment alone keeps the field mounted (a search box that writes
 * `?q=` as you type), so it keeps its focus.
 */
export function blurFocusedFieldOnNavigation(
  fromUrl: string,
  toUrl: string,
  doc: Document = document,
): boolean {
  if (pathOf(fromUrl) === pathOf(toUrl)) return false;
  const active = doc.activeElement;
  if (!isTextEntry(active)) return false;
  active.blur();
  return true;
}
