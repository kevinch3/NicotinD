import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { createMainWindow } from './window.js';
import { hardenWindow } from './security.js';
import { CH } from './ipc-channels.js';
import { Sidecar, type SidecarExitInfo } from './sidecar.js';
import { pickDirectoryResult } from './dialog-result.js';
import { initAutoUpdate } from './updater.js';
import { installTray } from './tray.js';

function htmlDataUrl(bodyHtml: string): string {
  return 'data:text/html,' + encodeURIComponent(`<html><body>${bodyHtml}</body></html>`);
}

const STARTING_URL = htmlDataUrl(
  '<div style="background:#111;color:#eee;font-family:sans-serif;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
    '<p>Starting NicotinD&hellip;</p></div>',
);

function errorPageUrl(message: string): string {
  return htmlDataUrl(
    '<div style="background:#111;color:#eee;font-family:sans-serif;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'height:100vh;margin:0;text-align:center;padding:0 2rem">' +
      '<p>NicotinD failed to start.</p>' +
      `<pre style="white-space:pre-wrap;opacity:0.7">${message.replace(/</g, '&lt;')}</pre>` +
      '</div>',
  );
}

let mainWindow: BrowserWindow | null = null;

// Constructed once at module load; `musicDir` isn't known yet (onboarding
// sets it later), so it starts unset and the backend uses its own config.
const sidecar = new Sidecar({});

// Single source of truth for "is the app shutting down for real?" — flipped
// to `true` by the tray "Quit" item and by `app.before-quit` (the only two
// paths that should actually terminate the process). The window `close`
// handler installed in `createWindow()` reads it to decide between
// hide-to-tray (Linux) vs. real-close (when this flag is set).
let quitting = false;

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function reloadWindow(url: string): void {
  if (!mainWindow) {
    return;
  }
  mainWindow.loadURL(url).catch((err: unknown) => {
    console.error('Failed to load window URL', url, err);
  });
}

/**
 * Registers the main-process side of the renderer-invoked IPC channels
 * (`preload.cts`). Handlers are registered once, ahead of window creation,
 * so they're available for the renderer's very first invoke call.
 *
 * The window-control channels (`window:minimize` / `window:maximize-toggle`
 * / `window:close`) use `ipcMain.on` — they're fire-and-forget from the
 * renderer side, so there's no value to promise-return and `invoke` would
 * just add an unneeded round-trip.
 */
function registerIpcHandlers(): void {
  ipcMain.handle(CH.pickDirectory, async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return pickDirectoryResult(res);
  });

  ipcMain.handle(CH.revealLogs, (): void => {
    shell.showItemInFolder(sidecar.logFilePath());
  });

  // Settings "Change music folder" (restart: true) and onboarding's
  // `chooseFolder()` (restart: false) both funnel through here. A successful
  // restart emits the sidecar's 'restart' event (handled below), which
  // reloads the window against the new URL — no separate reload call needed
  // here. A failed restart (e.g. the backend errors booting against the new
  // dir) rejects `sidecar.setMusicDir()`; caught here and reported back as a
  // structured `{ ok: false, error }` result instead of an unhandled IPC
  // rejection, so the renderer can surface it to the user (the sidecar
  // itself is left in a clean no-child state — see `Sidecar.setMusicDir`).
  ipcMain.handle(
    CH.setMusicDir,
    async (
      _event,
      dir: string,
      opts?: { restart?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        await sidecar.setMusicDir(dir, opts);
        return { ok: true };
      } catch (err) {
        console.error('Failed to change music folder', err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Window controls dispatched from the renderer's in-app chrome bar (the
  // `data-electron-title-bar` element on Linux). Fire-and-forget.
  ipcMain.on(CH.windowMinimize, () => {
    mainWindow?.minimize();
  });

  ipcMain.on(CH.windowMaximizeToggle, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(CH.windowClose, () => {
    mainWindow?.close();
  });
}

/**
 * Wires the `maximize` / `unmaximize` events on `win` so the renderer's
 * chrome-bar buttons can flip their maximize ↔ restore icons via the
 * `window:maximize-changed` IPC channel. Listener detached via
 * `mainWindow.on('closed', ...)` so we don't leak after shutdown.
 */
function relayMaximizeState(win: BrowserWindow): void {
  const broadcast = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(CH.windowMaximizeChanged, { isMaximized: win.isMaximized() });
  };
  win.on('maximize', broadcast);
  win.on('unmaximize', broadcast);
  // Initial state (window may already be maximized when listeners attach
  // — e.g. a previous session was restored maximized by the OS).
  broadcast();
}

async function createWindow(): Promise<void> {
  mainWindow = createMainWindow(STARTING_URL);
  hardenWindow(mainWindow);
  relayMaximizeState(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Linux-only hide-on-close: when the user closes the window we hide it
  // to the tray instead of quitting, so playback (and the backend) keep
  // running. macOS keeps the standard click-to-dock behavior. The shared
  // module-level `quitting` flag gates this — tray "Quit" and the
  // `app.before-quit` handler set it before the next close fires.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (process.platform === 'darwin') return;
    if (!mainWindow) return;
    event.preventDefault();
    mainWindow.hide();
  });

  try {
    const url = await sidecar.start();
    reloadWindow(url);
  } catch (err) {
    console.error('Sidecar failed to start', err);
    reloadWindow(errorPageUrl(err instanceof Error ? err.message : String(err)));
  }

  // Tray icon (installed after the window exists so its "Open" item can
  // show/focus the live window). On macOS the tray is a no-op helper that
  // still installs the menu items; the dock + Cmd-Q remain the primary
  // lifecycle surface there. The shared `quitting` flag keeps tray Quit
  // and `app.before-quit` on the same code path.
  installTray({
    getMainWindow: () => mainWindow,
    // Wrapper shape matches `InstallTrayOptions.createMainWindow`'s
    // `(url?: string)` — the tray passes a placeholder URL when
    // re-creating a destroyed window.
    createMainWindow: (url?: string) => createMainWindow(url ?? ''),
    sidecar,
    isQuitting: () => quitting,
    setQuitting: (value: boolean) => {
      quitting = value;
    },
  });

  // After the window is up and the sidecar has (attempted to) start —
  // update-checking must never block or delay startup. `initAutoUpdate`
  // itself no-ops in dev (`!app.isPackaged`), so no extra guard is needed
  // here.
  initAutoUpdate();
}

// A supervised restart (after an unexpected sidecar exit) reloads the window
// against the sidecar's new URL; exhausting all restart attempts shows an
// error page instead of leaving a dead window on screen.
sidecar.on('restart', (url: string) => {
  reloadWindow(url);
});

sidecar.on('exit', (info: SidecarExitInfo) => {
  console.error('Sidecar exhausted restart attempts', info);
  reloadWindow(
    errorPageUrl('The NicotinD backend stopped unexpectedly and could not be restarted.'),
  );
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    void createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Linux with hide-on-close: the window hides instead of closing, so
    // this event usually never fires there. The tray "Quit" path is the
    // real escape route (sets `quitting` then calls `app.quit()` below).
    // macOS keeps the standard click-to-dock convention by NOT quitting.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Ensure the sidecar is stopped (SIGTERM, graceful) before the app actually
  // exits. `before-quit` can fire more than once (e.g. `app.quit()` called
  // again below); the `quitting` guard makes the async stop-then-quit
  // sequence re-entrancy-safe instead of looping or racing.
  app.on('before-quit', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    quitting = true;
    void sidecar.stop().finally(() => {
      app.quit();
    });
  });
}
