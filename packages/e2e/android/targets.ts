/**
 * The Android emulator lanes (`bun run e2e:tv`, `bun run e2e:phone`) as one
 * table, so `preflight.ts` never branches on which lane it drives. Pure: no
 * adb, no fs, so everything here is unit-tested in CI (`targets.test.ts`)
 * while the lanes themselves stay local. See docs/e2e-tv-emulator.md.
 */

export type TargetName = 'tv' | 'phone';

export interface AndroidTarget {
  name: TargetName;
  /** The applicationId whose WebView the fixtures attach to. */
  appId: string;
  avd: string;
  /** What `avdmanager create avd` needs; printed when the AVD is missing. */
  systemImage: string;
  avdDevice: string;
  /** Own server port, so the lanes and the Chromium suite can run at once. */
  port: string;
  /** Gradle product flavour, as in `assemble<Flavour>Debug`. */
  flavour: 'Tv' | 'Phone';
  /** `ng build --configuration`, or null for the default (phone) build. */
  webConfiguration: string | null;
  /** Playwright config, relative to packages/e2e. */
  config: string;
  /** Packages stopped before launch so they cannot hold the foreground. */
  forceStop: string[];
  /** A device serial the user pinned, if any. */
  serial: string | undefined;
}

/** The launcher activity lives in the gradle namespace, which a flavour's
 *  applicationIdSuffix does not move — so it is the same for every lane. */
export const MAIN_ACTIVITY = 'ar.kevinroberts.nicotind.MainActivity';

const PHONE_APP_ID = 'ar.kevinroberts.nicotind';

export function targetFor(name: TargetName, env: NodeJS.ProcessEnv = process.env): AndroidTarget {
  if (name === 'tv') {
    return {
      name,
      // The `tv` flavour adds `.tv` (docs/fdroid.md).
      appId: `${PHONE_APP_ID}.tv`,
      avd: env.E2E_TV_AVD ?? 'nicotind-tv',
      systemImage: 'system-images;android-36;google-tv;x86_64',
      avdDevice: 'tv_1080p',
      port: env.E2E_TV_PORT ?? '8587',
      flavour: 'Tv',
      webConfiguration: 'tv',
      config: 'playwright.tv.config.ts',
      // The pre-flavour package is a leanback launcher app too; on a TV AVD that
      // ran this lane before the flavour existed it can take the foreground.
      forceStop: [PHONE_APP_ID],
      serial: env.E2E_TV_SERIAL,
    };
  }
  return {
    name,
    appId: PHONE_APP_ID,
    avd: env.E2E_PHONE_AVD ?? 'nicotind-phone',
    systemImage: 'system-images;android-36;google_apis;x86_64',
    avdDevice: 'pixel_6',
    // 8585–8590 are the Chromium suite's servers and fixtures.
    port: env.E2E_PHONE_PORT ?? '8591',
    flavour: 'Phone',
    webConfiguration: null,
    config: 'playwright.phone.config.ts',
    forceStop: [],
    serial: env.E2E_PHONE_SERIAL,
  };
}

/**
 * `--target=tv|phone` out of the argv, the rest passed through to Playwright.
 * Defaults to `tv` so the preflight's original invocation keeps meaning what it meant.
 */
export function parseTarget(argv: string[]): { target: TargetName; rest: string[] } {
  let target: TargetName = 'tv';
  const rest: string[] = [];
  for (const arg of argv) {
    if (!arg.startsWith('--target=')) {
      rest.push(arg);
      continue;
    }
    const value = arg.slice('--target='.length);
    if (value !== 'tv' && value !== 'phone') {
      throw new Error(`[e2e:android] unknown --target=${value}; expected tv or phone.`);
    }
    target = value;
  }
  return { target, rest };
}

/** One vibration from `dumpsys vibrator_manager`'s "Recent vibrations". */
export interface Vibration {
  /** Device-local `MM-DD HH:MM:SS.mmm`, the format `deviceClock` returns. */
  at: string;
  usage: string;
  /** What the vibrator actually played, e.g. `[Step=0ms(amplitude=0.00),Step=50ms(amplitude=0.43)]`. */
  played: string;
}

/**
 * The vibrations an app requested, oldest first.
 *
 * Matched on `<appId> (uid=` so the phone id never matches the `.tv` one.
 * The history is capped per usage, so callers compare timestamps
 * (`vibrationsSince`) rather than counting rows: a full history stops growing.
 */
export function parseVibrations(dumpsys: string, appId: string): Vibration[] {
  const out: Vibration[] = [];
  for (const line of dumpsys.split('\n')) {
    if (!line.includes(`| ${appId} (uid=`)) continue;
    const at = /^\s*(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})/.exec(line)?.[1];
    if (!at) continue;
    out.push({
      at,
      usage: /\| usage: (\S+)/.exec(line)?.[1] ?? '',
      played: /\| played: (.*?) \| original:/.exec(line)?.[1] ?? '',
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Strictly after the mark. Same-year assumption: a run spanning New Year is not worth a parser. */
export function vibrationsSince(all: Vibration[], mark: string): Vibration[] {
  return all.filter((v) => v.at > mark);
}

/** The app WebView's top-left in device pixels, from `uiautomator dump`. */
export function webViewOrigin(uiXml: string): { left: number; top: number } {
  const m = /class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]/.exec(uiXml);
  if (!m) throw new Error('[e2e:android] no WebView node in the uiautomator dump.');
  return { left: Number(m[1]), top: Number(m[2]) };
}

/**
 * CSS pixels in the page → device pixels for `adb shell input`.
 *
 * Needs the WebView's origin because it does not start at the top of the screen
 * when the system bars are padded (measured: top = 128 on a Pixel 6 AVD, API 36).
 */
export function toDevicePoint(
  css: { x: number; y: number },
  dpr: number,
  origin: { left: number; top: number },
): { x: number; y: number } {
  return {
    x: origin.left + Math.round(css.x * dpr),
    y: origin.top + Math.round(css.y * dpr),
  };
}
