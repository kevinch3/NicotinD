/**
 * The F-Droid build variant (issue #1168).
 *
 * F-Droid's inclusion policy forbids proprietary Google dependencies outright
 * and treats an app that installs APKs itself as bypassing the client's own
 * update checks. Two Capacitor plugins are the whole of our exposure, and both
 * are reached through the Capacitor global (`getCapacitorPlugin(...)` returning
 * null) rather than imported by the web bundle — so dropping them from the
 * native build needs no web-code change and degrades along paths the app
 * already supports on web and Electron.
 *
 * The variant is therefore expressed as a Capacitor plugin ALLOWLIST rather
 * than as a prebuild step that uninstalls packages: the same locked dependency
 * tree has to produce the smaller APK, or F-Droid cannot verify the build
 * against the source it was given.
 */

/**
 * Capacitor plugin packages excluded from the F-Droid variant, and what each
 * one costs us. Keep the reason with the entry — a later reader deciding
 * whether a plugin still has to be excluded needs the dependency, not the name.
 */
export const NON_FREE_PLUGINS = {
  /** Downloads a release APK and hands it to the system package installer.
   * On an F-Droid install the client is the updater, so this is redundant as
   * well as policy-sensitive, and it is what forces REQUEST_INSTALL_PACKAGES. */
  '@nicotind/capacitor-apk-update': 'self-installs APKs, bypassing F-Droid updates',
} as const;

/**
 * Capacitor plugins with Android code that are cleared for the F-Droid variant,
 * and the transitive dependency that clearance rests on.
 *
 * This exists so `check:fdroid` can assert its own denominator: a plugin added
 * later is neither here nor in {@link NON_FREE_PLUGINS}, and the gate fails
 * asking for a decision. Without it the allowlist would keep passing while
 * quietly shipping whatever the new plugin drags in — and a proprietary
 * transitive dep is invisible in `package.json`.
 */
export const FREE_ANDROID_PLUGINS = {
  '@capacitor/app': 'androidx only',
  '@capacitor/network': 'androidx only',
  '@capacitor/preferences': 'androidx only',
  '@jofr/capacitor-media-session': 'androidx media only',
  '@nicotind/capacitor-tv-channels': 'ours; androidx.tvprovider only',
  '@nicotind/capacitor-now-playing': 'ours; iOS-only Swift, no Android code',
} as const;

/**
 * The `android.includePlugins` allowlist for the F-Droid variant.
 *
 * Capacitor's default is to scan `dependencies` + `devDependencies`, and
 * `includePlugins` REPLACES that scan rather than subtracting from it — so this
 * reproduces the default list minus {@link NON_FREE_PLUGINS} instead of naming
 * the plugins to keep. A hand-written keep-list would silently omit any plugin
 * added later, which is the failure that ships a feature missing only on
 * F-Droid. Non-plugin packages in the list are harmless: Capacitor resolves
 * each entry and drops whatever has no plugin manifest.
 */
export function fdroidIncludePlugins(
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {},
): string[] {
  const excluded = new Set<string>(Object.keys(NON_FREE_PLUGINS));
  return [...Object.keys(dependencies), ...Object.keys(devDependencies)].filter(
    (name) => !excluded.has(name),
  );
}

/**
 * The application id for a build.
 *
 * F-Droid requires every app entry to have its own distinct application id, and
 * the phone and TV APKs currently share one — they differ only in the web
 * bundle `cap sync` copied in. The TV entry therefore takes a `.tv` suffix.
 *
 * The suffix is applied to the F-Droid variant ONLY. The sideloaded GitHub TV
 * APK keeps the bare id, so an F-Droid install lands alongside it rather than
 * failing to upgrade it — two distribution channels, two packages, and no
 * existing install is disturbed.
 */
export function fdroidAppId(baseId: string, tv: boolean): string {
  return tv ? `${baseId}.tv` : baseId;
}
