/**
 * The element that scrolls the app's pages. Inside the layout shell that is
 * `<main data-scroll-root>`, not the document: the shell is a fixed-height
 * column, so the fixed player and tab bar never share a scroller with the page
 * (on iOS standalone PWAs they rode the document scroll). Routes outside the
 * shell (login, setup) still scroll the document, hence the `window` fallback.
 */
export const SCROLL_ROOT_SELECTOR = '[data-scroll-root]';

export function scrollRootElement(): HTMLElement | null {
  return typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>(SCROLL_ROOT_SELECTOR);
}

export function scrollRootTop(): number {
  const root = scrollRootElement();
  return root ? root.scrollTop : typeof window === 'undefined' ? 0 : window.scrollY;
}

export function scrollRootTo(top: number): void {
  const root = scrollRootElement();
  if (root) root.scrollTo({ top });
  else window.scrollTo({ top });
}
