import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createMainWindow } from './window.js';
import { hardenWindow } from './security.js';
import { CH } from './ipc-channels.js';
import { Sidecar, type SidecarExitInfo } from './sidecar.js';
import { pickDirectoryResult } from './dialog-result.js';
import { initAutoUpdate } from './updater.js';

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

// CI-only lifecycle tracing for the packaged-boot smoke test (surfaced via the
// test's Electron-output tee). No-op in production (CI unset).
const dbg = (...a: unknown[]): void => {
  if (process.env.CI) console.log('[main]', ...a);
};
dbg('module loaded; CI=', process.env.CI, 'disableSI=', process.env.NICOTIND_DISABLE_SINGLE_INSTANCE);

// Constructed once at module load; `musicDir` isn't known yet (onboarding
// sets it later), so it starts unset and the backend uses its own config.
const sidecar = new Sidecar({});

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
 * Registers the main-process side of the folder-picker and reveal-logs IPC
 * channels invoked by the sandboxed preload (`preload.cts`). Handlers are
 * registered once, ahead of window creation, so they're available for the
 * renderer's very first invoke call.
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
}

/** Application menu with a "Reveal Logs" item pointed at the sidecar's log file. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reveal Logs',
          click: () => shell.showItemInFolder(sidecar.logFilePath()),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  dbg('createWindow: creating main window');
  mainWindow = createMainWindow(STARTING_URL);
  dbg('createWindow: main window created');
  hardenWindow(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  try {
    const url = await sidecar.start();
    dbg('createWindow: sidecar started at', url);
    reloadWindow(url);
  } catch (err) {
    console.error('Sidecar failed to start', err);
    reloadWindow(errorPageUrl(err instanceof Error ? err.message : String(err)));
  }

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

// The single-instance lock is bypassed when NICOTIND_DISABLE_SINGLE_INSTANCE=1.
// Under Playwright's `_electron` launcher (the packaged-boot smoke test)
// `requestSingleInstanceLock()` returns false, which would `app.quit()` before
// a window ever opens; the flag is set only by that test, so production keeps
// the real single-instance behavior.
const gotSingleInstanceLock =
  process.env.NICOTIND_DISABLE_SINGLE_INSTANCE === '1' || app.requestSingleInstanceLock();
dbg('single-instance lock =', gotSingleInstanceLock);

if (!gotSingleInstanceLock) {
  dbg('single-instance lock not acquired — quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    dbg('app ready');
    registerIpcHandlers();
    buildMenu();
    void createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Ensure the sidecar is stopped (SIGTERM, graceful) before the app actually
  // exits. `before-quit` can fire more than once (e.g. `app.quit()` called
  // again below); the `quitting` guard makes the async stop-then-quit
  // sequence re-entrant-safe instead of looping or racing.
  let quitting = false;
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
