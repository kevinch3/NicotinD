import { environment } from '../../environments/environment';

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
    (globalThis as { window?: { nicotind?: { platform?: string } } }).window?.nicotind?.platform ===
    'electron'
  );
}

/**
 * Host OS the Electron shell is running on, as captured by the preload's
 * synchronous `process.platform` snapshot and surfaced on
 * `window.nicotind.os`. Returns `null` outside Electron (web, Capacitor)
 * so callers can branch safely.
 *
 * Used by the layout header to render the in-app window-control buttons
 * only on Linux/Win — macOS keeps the native traffic lights and there's
 * nothing to add to the chrome bar.
 */
export function electronOS(): NodeJS.Platform | null {
  const os = (globalThis as { window?: { nicotind?: { os?: unknown } } }).window?.nicotind?.os;
  if (os === 'darwin' || os === 'linux' || os === 'win32') {
    return os;
  }
  return null;
}

/**
 * True only inside the desktop shell on a platform that draws its own
 * window chrome (`frame: false` — Linux today, Windows when a target is
 * added). Drives the in-app window-control buttons + the
 * `-webkit-app-region: drag` regions; macOS keeps `titleBarStyle:
 * 'hiddenInset'` (native traffic lights) and is excluded here.
 */
export function isElectronLinux(): boolean {
  const os = electronOS();
  return isElectron() && os !== null && os !== 'darwin';
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

/** True on devices whose primary pointer is coarse (touch phones/tablets).
 *  Gates touch-only affordances like pull-to-refresh. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * True only in a build made with the Angular "tv" configuration
 * (`ng build --configuration tv`), baked in via environment.tv.ts. Used to
 * default TV-only behaviors (e.g. RemotePlaybackService's opt-in) without
 * runtime Android UiModeManager detection, since sideload-only distribution
 * doesn't need it.
 */
export function isTvBuild(): boolean {
  return environment.tvBuild;
}

/**
 * Stamps the `tv-build` class on the document root of a TV build, so styles.css
 * can apply TV-only layout (the overscan safe-area insets — TVs may crop up to
 * ~5% of every edge, so content must stay inside an action-safe area while
 * backgrounds bleed). Called once at bootstrap (main.ts).
 */
export function applyTvBuildClass(
  el: HTMLElement = document.documentElement,
  tv: boolean = isTvBuild(),
): void {
  if (tv) el.classList.add('tv-build');
}

/**
 * Resolves a boolean localStorage preference that defaults to `true` on a TV
 * build only when the user has never explicitly set it — an explicit stored
 * choice (true or false) always wins. Shared by every reader of the
 * `nicotind_remote_enabled` key so "TV defaults it on" can't drift between
 * call sites (playback-ws.service.ts used to carry its own independent copy
 * of this logic, so the WS REGISTER payload disagreed with the UI's own
 * `RemotePlaybackService.remoteEnabled` signal).
 */
export function resolveTvDefaultedPreference(stored: string | null, tvBuild: boolean): boolean {
  return stored !== null ? stored === 'true' : tvBuild;
}
