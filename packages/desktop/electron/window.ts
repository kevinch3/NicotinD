import { BrowserWindow } from 'electron';
import { windowOptionsForPlatform } from './window-options.js';
import { appIconPath } from './paths.js';

/**
 * Creates the app's single main window and loads `url` into it.
 *
 * Per-platform chrome shape lives in `window-options.ts` (pure /
 * unit-testable); this module is the runtime wiring that constructs an
 * actual `BrowserWindow` and starts loading the renderer.
 *
 * Security-relevant `webPreferences` are pinned in `windowOptionsForPlatform`
 * (context isolation on, node integration off, sandboxed renderer).
 * Further hardening (navigation pinning, CSP, popup handling) is applied
 * separately via `hardenWindow` so the two concerns stay easy to reason
 * about independently.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow(windowOptionsForPlatform(process.platform, appIconPath(process.platform)));

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadURL(url).catch((err: unknown) => {
    console.error('Failed to load window URL', url, err);
  });

  return win;
}

export { windowOptionsForPlatform };
