/**
 * The iOS Simulator lane's checks, driven over Appium (XCUITest driver).
 * Run by `.github/workflows/ios-simulator.yml`, which builds the app, boots
 * the Simulator, starts Appium and a throwaway server first. See
 * docs/e2e-ios-simulator.md.
 *
 * Every step is recorded (and screenshotted) whether it passes or not, and the
 * report is uploaded as an artifact: on a runner you cannot log into, the
 * report IS the debugging session.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebDriver } from './webdriver.js';
import {
  appWebview,
  hapticCalls,
  swipeActions,
  toScreen,
  viewportOffset,
  type AppiumContext,
  type NativeCall,
  type Point,
} from './lane.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`[e2e:ios] ${name} is not set; run this from the ios-simulator workflow.`);
  return v;
}

const APPIUM = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const APP_PATH = required('IOS_APP_PATH');
const UDID = required('IOS_UDID');
const PORT = process.env.IOS_API_PORT ?? '8591';
const OUT = process.env.IOS_OUT_DIR ?? 'ios-results';
/** Where the workflow prebuilt WebDriverAgent; unset means Appium builds it inside the session. */
const WDA_DERIVED_DATA = process.env.IOS_WDA_DERIVED_DATA;
const API = `http://127.0.0.1:${PORT}`;
const USER = { username: 'ios-admin', password: 'ios-password-123' };
/** lib/swipe-to-skip.ts SKIP_THRESHOLD_PX is 80 (CSS px = points on iOS). */
const COMMIT_DX = -260;
const CANCEL_DX = -15;

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

mkdirSync(OUT, { recursive: true });
const steps: Step[] = [];
const driver = new WebDriver(APPIUM);
let sessionUp = false;
let webview = '';
let shots = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  let result: T | undefined;
  try {
    result = await fn();
    steps.push({ name, ok: true, ms: Date.now() - started, detail: result });
    console.log(`✓ ${name}`, result === undefined ? '' : JSON.stringify(result));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    steps.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`✘ ${name}: ${error}`);
  }
  if (sessionUp) {
    const png = await driver.screenshot().catch(() => '');
    const file = `${String(++shots).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`;
    if (png) writeFileSync(join(OUT, file), Buffer.from(png, 'base64'));
  }
  return result;
}

async function poll<T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false && v !== '') return v;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${last})` : ''}`,
  );
}

/** Back into the page. A navigation can replace the WebView's page, so re-pick it each time. */
async function inPage(): Promise<void> {
  webview = await poll(
    'the app WebView context',
    async () => appWebview((await driver.contexts()) as AppiumContext[]),
    30_000,
  );
  await driver.setContext(webview);
}

const inNative = () => driver.setContext('NATIVE_APP');

const js = <T>(script: string, args: unknown[] = []) => driver.execute<T>(script, args);

/** Wrap the one function every plugin call crosses (Capacitor's `toNative`). Lost on reload. */
const SPY = `
  const cap = window.Capacitor;
  if (!cap) return 'no Capacitor global';
  if (cap.__nicotindSpy) return 'already installed';
  window.__nativeCalls = [];
  const key = typeof cap.toNative === 'function' ? 'toNative' : 'nativePromise';
  const orig = cap[key].bind(cap);
  cap[key] = (plugin, method, ...rest) => {
    window.__nativeCalls.push({ plugin, method });
    return orig(plugin, method, ...rest);
  };
  cap.__nicotindSpy = true;
  return 'wrapped ' + key;
`;

const nativeCalls = () => js<NativeCall[]>('return window.__nativeCalls || [];');
const title = () =>
  js<string>(
    `return (document.querySelector('[data-testid="player-title"]')?.textContent || '').trim();`,
  );

let token = '';
let albumId = '';
let offset: Point | undefined;
let coverCentre: Point | undefined;

await step('server: sign in and find an album', async () => {
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(USER),
    });
    if (res.ok) {
      token = ((await res.json()) as { token: string }).token;
      break;
    }
  }
  if (!token) throw new Error('no token');
  albumId = await poll(
    'a scanned album',
    async () => {
      const res = await fetch(`${API}/api/library/albums?size=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok ? ((await res.json()) as { id: string }[])[0]?.id : null;
    },
    90_000,
  );
  return { albumId };
});

await step('appium: start a session on the simulator', async () => {
  await driver.start({
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': UDID,
    'appium:app': APP_PATH,
    // The workflow boots the Simulator with `simctl boot`, which has no window.
    // Without this, Appium restarts it "with the UI visible" and that second boot
    // overran its 120 s budget on the macos-26 runner (measured 2026-11-15).
    'appium:isHeadless': true,
    'appium:simulatorStartupTimeout': 300_000,
    // The software keyboard, not the Mac's: #1635 lives in what it does to the viewport.
    'appium:connectHardwareKeyboard': false,
    'appium:fullContextList': true,
    // The Simulator's web inspector names the app after its executable ("App",
    // Capacitor's target), not its bundle id, so Appium skipped its page until
    // told to match it (measured 2026-11-15). Named exactly, not '*'.
    'appium:additionalWebviewBundleIds': ['process-App'],
    'appium:webviewConnectTimeout': 30_000,
    'appium:wdaLaunchTimeout': 300_000,
    'appium:wdaConnectionTimeout': 300_000,
    'appium:newCommandTimeout': 600,
    'appium:showXcodeLog': true,
    ...(WDA_DERIVED_DATA
      ? { 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': WDA_DERIVED_DATA }
      : {}),
  });
  sessionUp = true;
});

const attached =
  sessionUp &&
  (await step('webview: the app page is attachable', async () => {
    await inPage();
    return js<Record<string, unknown>>(`return {
    href: location.href,
    platform: window.Capacitor?.getPlatform?.() ?? null,
    dpr: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
  };`);
  }));

if (attached) {
  await step('page: sign in and open an album', async () => {
    const origin = await js<string>('return location.origin;');
    await js(
      `localStorage.setItem('nicotind_server_url', arguments[0]);
       localStorage.setItem('nicotind_token', arguments[1]);
       localStorage.setItem('nicotind_username', arguments[2]);
       localStorage.setItem('nicotind_role', 'admin');
       setTimeout(() => location.replace(arguments[3]), 0);
       return true;`,
      [`http://localhost:${PORT}`, token, USER.username, `${origin}/library/albums/${albumId}`],
    );
    return poll(
      'the album page',
      async () => {
        await inPage();
        return js<boolean>(`return !!document.querySelector('[data-testid="play-album"]');`);
      },
      45_000,
    );
  });

  await step('page: spy on the Capacitor bridge', () => js<string>(SPY));

  await step('page: play the album', async () => {
    await driver.click(await driver.find('css selector', '[data-testid="play-album"]'));
    return poll('a player title', title, 20_000);
  });

  await step('page: open Now Playing and let the cover settle', async () => {
    await driver.click(await driver.find('css selector', '[data-testid="player-title"]'));
    let last = '';
    const rect = await poll(
      'a settled cover',
      async () => {
        const r = await js<{ x: number; y: number; w: number; h: number } | null>(`
          const el = document.querySelector('[data-testid="now-playing-cover-art"]');
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };`);
        const now = r && r.h > 0 ? JSON.stringify(r) : '';
        const settled = now !== '' && now === last;
        last = now;
        return settled ? r : null;
      },
      20_000,
    );
    coverCentre = { x: rect!.x + rect!.w / 2, y: rect!.y + rect!.h / 2 };
    return { cover: rect, centre: coverCentre };
  });

  await step('geometry: calibrate page → screen with one tap', async () => {
    if (!coverCentre) throw new Error('no cover');
    await js(`window.__touch = null;
      document.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        window.__touch = { x: t.clientX, y: t.clientY };
      }, { capture: true, once: true });
      return true;`);
    await inNative();
    const wv = await driver.rect(await driver.find('class name', 'XCUIElementTypeWebView'));
    // First guess: CSS (0,0) at the WebView's corner. The tap tells us the truth.
    const guess = { x: Math.round(wv.x + coverCentre.x), y: Math.round(wv.y + coverCentre.y) };
    await driver.actions({
      actions: [
        {
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: guess.x, y: guess.y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 60 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await inPage();
    const touch = await poll(
      'the calibration touch',
      () => js<Point | null>('return window.__touch;'),
      5_000,
    );
    offset = viewportOffset(guess, touch);
    return { webviewRect: wv, tappedAt: guess, pageSaw: touch, offset };
  });

  for (const [name, dx, expectSkip] of [
    ['swipe: a committed swipe skips and calls Haptics once', COMMIT_DX, true],
    ['swipe: a cancelled swipe neither skips nor calls Haptics', CANCEL_DX, false],
  ] as const) {
    await step(name, async () => {
      if (!offset || !coverCentre) throw new Error('not calibrated');
      await inPage();
      const before = await title();
      const callsBefore = hapticCalls(await nativeCalls()).length;
      await inNative();
      await driver.actions(
        swipeActions(toScreen(coverCentre, offset), dx, dx === CANCEL_DX ? 250 : 200),
      );
      await Bun.sleep(1500);
      await inPage();
      const after = await title();
      const haptics = hapticCalls(await nativeCalls()).slice(callsBefore);
      const skipped = after !== before;
      const result = { before, after, skipped, haptics };
      if (skipped !== expectSkip) throw new Error(`skipped=${skipped}: ${JSON.stringify(result)}`);
      if (haptics.length !== (expectSkip ? 1 : 0)) {
        throw new Error(`haptic calls=${haptics.length}: ${JSON.stringify(result)}`);
      }
      return result;
    });
  }
}

await driver.quit();
const failed = steps.filter((s) => !s.ok);
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ udid: UDID, steps }, null, 2));
console.log(
  `\n${steps.length - failed.length}/${steps.length} steps passed; report in ${OUT}/report.json`,
);
process.exit(failed.length === 0 ? 0 : 1);
