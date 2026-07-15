/**
 * Pure platform/signing gate for the auto-update behavior. Factored out of
 * `updater.ts` (which imports `electron`) so it's unit-testable without
 * booting Electron — see `dialog-result.ts` for the same pattern.
 *
 * electron-updater's Squirrel.Mac backend refuses to apply an update to an
 * unsigned macOS app (no Apple Developer ID in scope for v1 — see
 * electron-builder.yml `mac.identity: null`), so unsigned macOS degrades to
 * a notify-only flow that links out to the GitHub Releases page instead of
 * downloading/installing in-place. Every other platform (and a macOS build
 * that becomes signed in the future) gets the full apply flow.
 */
export function updateMode(platform: NodeJS.Platform, signed: boolean): 'apply' | 'notify' {
  return platform === 'darwin' && !signed ? 'notify' : 'apply';
}
