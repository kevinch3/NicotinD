import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
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
