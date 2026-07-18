/**
 * Pure decision for whether a window `close` event should be intercepted
 * and turned into hide-to-tray (Linux/Windows) vs. allowed to dismiss
 * the window normally. Factored out of `tray.ts` (which imports
 * `electron`) so it's unit-testable without booting Electron — same
 * pattern as `updateMode` / `shouldRestart`.
 *
 * - **darwin:** never hide — Apple's app lifecycle preserves the running
 *   dock icon by default, and intercepting close would break the macOS
 *   "click-to-dock" / `window-all-closed`-doesn't-quit convention.
 * - **linux/windows with a quit in progress (`isQuitting`):** don't
 *   intercept — the user explicitly asked to quit and we must let the
 *   window actually close so `app.before-quit` proceeds.
 * - **linux/windows otherwise:** hide — keeps the backend (and any
 *   in-progress playback) running for the user to bring back via the
 *   tray "Open NicotinD" item.
 */
export function shouldHideOnClose(
  platform: NodeJS.Platform,
  isQuitting: boolean,
): boolean {
  if (isQuitting) return false;
  return platform !== 'darwin';
}
