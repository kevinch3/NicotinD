import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path to the preload script. The preload is authored as CommonJS
 * (`electron/preload.cts` -> `dist/preload.cjs`) because Electron sandboxed
 * preloads (`sandbox: true`, set below) must be a single self-contained
 * CommonJS file; this module only needs to know where it will live on disk
 * once built.
 */
export const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

/**
 * Per-platform `BrowserWindow` constructor options, factored out of
 * `window.ts` so the platform-conditional chrome shape is pure /
 * unit-testable without booting Electron — see `window-options.test.ts`.
 *
 * - **darwin (`titleBarStyle: 'hiddenInset'`):** keeps the native traffic
 *   lights in their normal top-left slot, drops the title-bar text/shrink.
 *   The renderer's `<header>` paints right under them; the brand+nav gets
 *   a `-webkit-app-region: drag` strip so the user can drag the window
 *   from the chrome they actually see. `trafficLightPosition` nudges the
 *   green/yellow/red cluster so it doesn't sit on top of the brand mark.
 * - **everything else (`frame: false, titleBarStyle: 'hidden'`):** fully
 *   chromeless. The renderer paints its own min/max/close buttons in the
 *   header (Linux UX; Win just falls through to the same shape if/when a
 *   Windows target is added). Drag region is `-webkit-app-region: drag`
 *   on the same `<header>`.
 *
 * `iconPath`, when given and present on disk, is used as the window icon;
 * absent / non-existent paths are silently dropped (electron falls back to
 * the default icon). `createMainWindow` resolves it from `paths.appIconPath`
 * so dev runs without a staged resources/ dir still render the real brand
 * mark from the PWA icons.
 */
export function windowOptionsForPlatform(
  platform: NodeJS.Platform,
  iconPath?: string | null,
): Electron.BrowserWindowConstructorOptions {
  const isMac = platform === 'darwin';
  const icon = iconPath && existsSync(iconPath) ? iconPath : undefined;

  if (isMac) {
    return {
      width: 1280,
      height: 800,
      show: false,
      titleBarStyle: 'hiddenInset',
      // Lift the traffic lights above the brand mark + nav row so they
      // never occlude content. Tunable; matches the standard top-bar
      // inset on macOS media apps.
      trafficLightPosition: { x: 14, y: 14 },
      ...(icon ? { icon } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: PRELOAD_PATH,
      },
    };
  }

  return {
    width: 1280,
    height: 800,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  };
}
