/**
 * The in-app PWA install experience (web.dev "promote-install"): capture the
 * browser's `beforeinstallprompt`, decide when to promote, and remember a
 * refusal per device. Everything here is DI-free so the service and the specs
 * can drive it without a browser that actually fires the event.
 */

/** Chromium's `beforeinstallprompt` event — not in lib.dom, still a proposal. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const INSTALL_PROMO_DISMISSED_KEY = 'nicotind-install-promo-dismissed';

type PromptListener = (event: BeforeInstallPromptEvent) => void;

let stashed: BeforeInstallPromptEvent | null = null;
const listeners = new Set<PromptListener>();

/**
 * Attach the `beforeinstallprompt` listener. Called from `main.ts` *before*
 * `bootstrapApplication`: Chromium fires the event once, early, and never
 * replays it, so a listener attached from an Angular service that is first
 * injected after the event has fired sees nothing — the same no-replay trap as
 * `SwUpdate.versionUpdates` (#1126). `preventDefault()` suppresses Chrome's own
 * mini-infobar, which is the trade: we own *when* the prompt shows, so the
 * promotion in the app has to exist.
 */
export function captureInstallPrompt(target: EventTarget = window): void {
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    stashed = e as BeforeInstallPromptEvent;
    for (const cb of listeners) cb(stashed);
  });
}

/** The event captured before this caller existed, if any. */
export function stashedInstallPrompt(): BeforeInstallPromptEvent | null {
  return stashed;
}

/** Subscribe to future captures. Returns the unsubscribe. */
export function onInstallPrompt(cb: PromptListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A used prompt is spent — the browser fires a fresh event if it is installable again. */
export function clearStashedInstallPrompt(): void {
  stashed = null;
}

/** Test seam: forget everything captured. */
export function resetInstallPromptCapture(): void {
  stashed = null;
  listeners.clear();
}

/**
 * Already running as an installed app: launched from a home-screen icon
 * (`display-mode` standalone/fullscreen/minimal-ui) or, on iOS, the WebKit-only
 * `navigator.standalone`. An installed app must never be asked to install.
 */
export function isStandaloneDisplay(
  win: {
    matchMedia?: (q: string) => { matches: boolean };
    // `userAgent` is only here so a real `Navigator` overlaps the type (TS2559).
    navigator?: { standalone?: boolean; userAgent?: string };
  } = window,
): boolean {
  if (win.navigator?.standalone === true) return true;
  if (typeof win.matchMedia !== 'function') return false;
  return ['standalone', 'fullscreen', 'minimal-ui'].some(
    (mode) => win.matchMedia!(`(display-mode: ${mode})`).matches,
  );
}

/**
 * iOS never fires `beforeinstallprompt`; the only install path is Share → Add
 * to Home Screen, so the app has to *say* so. iPadOS 13+ reports a Macintosh UA
 * with touch points, hence the second clause.
 */
export function isIosBrowser(
  nav: { userAgent?: string; maxTouchPoints?: number; platform?: string } = navigator,
): boolean {
  const ua = nav.userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export interface InstallPromotionInputs {
  /** A captured `beforeinstallprompt` is on hand. */
  canInstall: boolean;
  /** iOS browser: no prompt exists, only the manual instructions. */
  iosManual: boolean;
  /** Running standalone already, or `appinstalled` fired this session. */
  installed: boolean;
  /** The user closed the promotion on this device. */
  dismissed: boolean;
  /** Capacitor / Electron / TV: the app *is* the native shell. */
  nativeShell: boolean;
}

/**
 * Pure decision for the promotion strip. Shown only once there is something to
 * offer (web.dev: never before `beforeinstallprompt`), never inside a native
 * shell or an installed app, and never again once dismissed on this device.
 */
export function installPromotionVisible(i: InstallPromotionInputs): boolean {
  if (i.nativeShell || i.installed || i.dismissed) return false;
  return i.canInstall || i.iosManual;
}

export function loadInstallPromoDismissed(
  storage: Pick<Storage, 'getItem'> = localStorage,
): boolean {
  try {
    return storage.getItem(INSTALL_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveInstallPromoDismissed(storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(INSTALL_PROMO_DISMISSED_KEY, '1');
  } catch {
    // Private mode / quota: the strip comes back next visit, nothing worse.
  }
}
