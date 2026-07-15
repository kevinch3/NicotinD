import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path to the preload script. The preload bundle itself is authored in
 * Task 8 (`electron/preload.ts` -> `dist/preload.js`); this module only
 * needs to know where it will live on disk once built.
 */
export const PRELOAD_PATH = path.join(__dirname, 'preload.js');

/**
 * Creates the app's single main window and loads `url` into it.
 *
 * Security-relevant `webPreferences` are pinned here (context isolation on,
 * node integration off, sandboxed renderer). Further hardening (navigation
 * pinning, CSP, popup handling) is applied separately via `hardenWindow`
 * so the two concerns stay easy to reason about independently.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  void win.loadURL(url);

  return win;
}
