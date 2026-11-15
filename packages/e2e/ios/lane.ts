/**
 * Pure pieces of the iOS Simulator lane (`.github/workflows/ios-simulator.yml`,
 * docs/e2e-ios-simulator.md). No simctl, no Appium, no fs — so they are
 * unit-tested on Linux in CI (`lane.test.ts`) while the lane itself needs a Mac.
 */

/** `xcrun simctl list devices available -j`, reduced to what we read. */
export interface SimctlList {
  devices: Record<string, { udid: string; name: string; isAvailable?: boolean; state?: string }[]>;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-0` → [26, 0]; non-iOS runtimes → null. */
function iosVersion(runtime: string): number[] | null {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The newest iOS runtime's first available iPhone. Picking by runtime, not by a
 * hard-coded name, survives the runner image renaming its devices every Xcode.
 */
export function pickSimulator(list: SimctlList): Simulator {
  const runtimes = Object.keys(list.devices)
    .map((runtime) => ({ runtime, v: iosVersion(runtime) }))
    .filter((r): r is { runtime: string; v: number[] } => r.v !== null)
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]);
  for (const { runtime } of runtimes) {
    const phone = list.devices[runtime].find(
      (d) => d.isAvailable !== false && d.name.startsWith('iPhone'),
    );
    if (phone) return { udid: phone.udid, name: phone.name, runtime };
  }
  throw new Error('[e2e:ios] no available iPhone simulator on any iOS runtime.');
}

/** A context as Appium lists it: a bare name, or an object with `fullContextList`. */
export type AppiumContext = string | { id: string; url?: string; title?: string };

/**
 * The app's WebView context. Capacitor serves the app from `capacitor://localhost`,
 * so prefer the context on that origin; a bare `WEBVIEW_…` name is the fallback when
 * Appium did not report URLs.
 */
export function appWebview(contexts: AppiumContext[]): string | null {
  const objects = contexts.map((c) => (typeof c === 'string' ? { id: c } : c));
  const webviews = objects.filter((c) => c.id.startsWith('WEBVIEW'));
  const onApp = webviews.find((c) => c.url?.startsWith('capacitor://'));
  return (onApp ?? webviews[0])?.id ?? null;
}

/** One call that crossed the Capacitor bridge, as the page-side spy records it. */
export interface NativeCall {
  plugin: string;
  method: string;
}

/** The haptic calls among everything the spy saw. */
export function hapticCalls(calls: NativeCall[]): NativeCall[] {
  return calls.filter((c) => c.plugin === 'Haptics');
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where the page's CSS pixel (0,0) sits on screen, in points. Measured by one
 * tap: XCUITest taps a known screen point and the page records the touch's
 * `clientX/Y`. On iOS a CSS pixel is a point, so the difference is the whole
 * mapping — no assumption about safe areas, `contentInset` or the status bar.
 */
export function viewportOffset(screenTap: Point, client: Point): Point {
  return { x: screenTap.x - client.x, y: screenTap.y - client.y };
}

export function toScreen(css: Point, offset: Point): Point {
  return { x: Math.round(css.x + offset.x), y: Math.round(css.y + offset.y) };
}

/** W3C actions for a one-finger horizontal swipe of `dx` points centred on `at`. */
export function swipeActions(at: Point, dx: number, ms: number): unknown {
  const from = { x: Math.round(at.x - dx / 2), y: Math.round(at.y) };
  const to = { x: Math.round(at.x + dx / 2), y: Math.round(at.y) };
  return {
    actions: [
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: ms, x: to.x, y: to.y },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  };
}

/** W3C actions for a short one-finger tap at `at`. */
export function tapActions(at: Point): unknown {
  return {
    actions: [
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(at.x), y: Math.round(at.y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 60 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  };
}
