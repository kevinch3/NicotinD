import { BrowserWindow, Menu, Tray, app, shell } from 'electron';
import type { Sidecar } from './sidecar.js';
import { trayIconPath } from './paths.js';

export interface InstallTrayOptions {
  /** Returns the current main `BrowserWindow`, or `null` if it's been destroyed. */
  getMainWindow: () => BrowserWindow | null;
  /** Creates a fresh main window (used by the tray "Open" item when the window is gone). */
  createMainWindow: (url?: string) => BrowserWindow;
  /** Sidecar instance — used for the "Reveal Logs" entry; its log file path. */
  sidecar: Pick<Sidecar, 'logFilePath'>;
  /** Shared quit-in-progress flag with main.ts. */
  isQuitting: () => boolean;
  setQuitting: (value: boolean) => void;
}

/**
 * Installs the OS tray icon + menu (`Open`, `Reveal Logs`, `Quit`).
 *
 * One tray instance per app; `main.ts` calls this exactly once after the
 * window exists. The tray lives across window hide/restore, so
 * re-opening from the tray is always available — on Linux it's the
 * only way to restore the window once the close-to-hide flow has fired.
 *
 * Returns `null` when no tray icon image is available on the current
 * dev run (no PWA `icon-32.png` in the repo checkout, no staged prod
 * icon) — gracefully degrades to no-tray rather than crashing the app
 * boot.
 */
export function installTray(opts: InstallTrayOptions): Tray | null {
  const iconPath = trayIconPath(process.platform);
  if (!iconPath) {
    // No icon on disk: skip the tray rather than trying to construct one
    // with an empty image (some platforms throw and others show a blank
    // placeholder that confuses users).
    return null;
  }
  const tray = new Tray(iconPath);
  tray.setToolTip('NicotinD');
  tray.setContextMenu(buildMenu(opts));
  tray.on('click', () => {
    showOrFocus(opts);
  });
  return tray;
}

function buildMenu(opts: InstallTrayOptions): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Open NicotinD',
      click: () => showOrFocus(opts),
    },
    {
      label: 'Reveal Logs',
      click: () => {
        shell.showItemInFolder(opts.sidecar.logFilePath());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit NicotinD',
      click: () => {
        // Reuse the module-level `quitting` flag from main.ts so the
        // close handler installed in createWindow() doesn't intercept
        // the next close event and hide us back to the tray.
        opts.setQuitting(true);
        app.quit();
      },
    },
  ]);
}

function showOrFocus(opts: InstallTrayOptions): void {
  const existing = opts.getMainWindow();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return;
  }
  // The window's been destroyed (typically a `window-all-closed` on
  // Linux after a quit, or a macOS reactivation after all-closed).
  // Recreate it with a placeholder URL — `createWindow()` will reload
  // against the real sidecar URL once `sidecar.start()` resolves.
  const win = opts.createMainWindow('data:text/html,<html><body>Loading…</body></html>');
  win.once('ready-to-show', () => win.show());
}
