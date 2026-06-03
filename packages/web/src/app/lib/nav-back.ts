/**
 * Decide whether a "back" action should pop browser history (returning to the
 * previous in-app view) or fall back to a default route.
 *
 * The router emits one NavigationEnd for the initial app load; a count > 1 means
 * we have navigated within the app, so `history.back()` will land on a previous
 * in-app view rather than leaving the site (e.g. when the page was opened via a
 * shared deep-link in a fresh tab).
 */
export function shouldUseBrowserBack(inAppNavigations: number): boolean {
  return inAppNavigations > 1;
}
