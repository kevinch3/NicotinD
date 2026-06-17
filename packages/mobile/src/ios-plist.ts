/**
 * Build the `PlistBuddy` commands that patch the *generated* iOS `Info.plist`
 * with the native config we can't keep in a committed plist (the `ios/` project
 * is generated ephemerally in CI — see docs/ios-app.md). Kept pure so the
 * command construction is unit-testable on Linux without Xcode.
 *
 * - `UIBackgroundModes: [audio]` — required for the WebView to keep audio alive
 *   when backgrounded (the iOS analogue of Android's media foreground service).
 * - `CFBundleShortVersionString` / `CFBundleVersion` — the marketing + build
 *   numbers derived from the monorepo version (see {@link iosVersion}).
 *
 * Each `Set` is preceded by an `Add` of the same key so it works whether or not
 * the key already exists; the `Add` is allowed to fail (key present) and the
 * `Set` then wins. The array key is deleted first so re-runs stay idempotent.
 */
export function buildPlistBuddyCommands(opts: {
  shortVersion?: string;
  build?: number | string;
}): string[] {
  const cmds: string[] = [
    'Delete :UIBackgroundModes',
    'Add :UIBackgroundModes array',
    'Add :UIBackgroundModes:0 string audio',
  ];
  if (opts.shortVersion) {
    cmds.push(`Add :CFBundleShortVersionString string ${opts.shortVersion}`);
    cmds.push(`Set :CFBundleShortVersionString ${opts.shortVersion}`);
  }
  if (opts.build !== undefined && opts.build !== '') {
    cmds.push(`Add :CFBundleVersion string ${opts.build}`);
    cmds.push(`Set :CFBundleVersion ${opts.build}`);
  }
  return cmds;
}
