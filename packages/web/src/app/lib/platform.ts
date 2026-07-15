// Capacitor injects a global `Capacitor` object into the native WebView (Android
// and iOS); it is absent in a normal browser. Detecting it here (instead of
// importing @capacitor/core) keeps the web bundle free of native deps — the same
// built `dist/` is shipped to the browser and both native shells. Native plugins
// self-register onto `Capacitor.Plugins`, so we reach them through the same
// global rather than an import.
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativePlatform(): boolean {
  const cap = capacitor();
  return typeof cap?.isNativePlatform === 'function' ? cap.isNativePlatform() : false;
}

/** 'ios' | 'android' when running in the native shell, else 'web'. */
export function getPlatform(): 'ios' | 'android' | 'web' {
  const p = capacitor()?.getPlatform?.();
  return p === 'ios' || p === 'android' ? p : 'web';
}

/** True only inside the native iOS shell (not the mobile browser). */
export function isIosNative(): boolean {
  return isNativePlatform() && getPlatform() === 'ios';
}

/** A registered Capacitor native plugin by name, or null when unavailable. */
export function getCapacitorPlugin<T>(name: string): T | null {
  return (capacitor()?.Plugins?.[name] as T | undefined) ?? null;
}

// The Electron desktop shell's preload script injects `window.nicotind` (see
// services/native/native-capabilities.ts for the shared NativeBridge type).
// Detected the same way as Capacitor above — via the global, no electron
// import — so the same built `dist/` ships to the browser and the desktop shell.
export function isElectron(): boolean {
  return (
    (globalThis as { window?: { nicotind?: { platform?: string } } }).window?.nicotind
      ?.platform === 'electron'
  );
}

/** True inside any native shell: Capacitor (iOS/Android) or Electron (desktop). */
export function isNativeShell(): boolean {
  return isNativePlatform() || isElectron();
}

/**
 * Pure decision for whether the Angular service worker should register.
 * Disabled in dev and inside any native shell (Capacitor or Electron) — the
 * Electron renderer loads the backend over real http and isn't caught by
 * `isNativePlatform()`, but we still don't want SW cross-update cache
 * surprises there, matching the mobile shells.
 */
export function serviceWorkerEnabled(devMode: boolean, nativeShell: boolean): boolean {
  return !devMode && !nativeShell;
}
