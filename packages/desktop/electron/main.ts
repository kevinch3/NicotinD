import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createMainWindow } from './window.js';
import { hardenWindow } from './security.js';
import { CH } from './ipc-channels.js';

// Placeholder shown until Task 9 wires up the Bun sidecar supervisor and
// swaps this for the sidecar's real 127.0.0.1 URL.
const PLACEHOLDER_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="background:#111;color:#eee;font-family:sans-serif;' +
      'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
      '<p>Starting NicotinD&hellip;</p></body></html>',
  );

let mainWindow: BrowserWindow | null = null;

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

/**
 * Registers the main-process side of the folder-picker IPC channel invoked
 * by the sandboxed preload (`preload.cts`). Handler is registered once,
 * ahead of window creation, so it's available for the renderer's very first
 * invoke call.
 */
function registerIpcHandlers(): void {
  ipcMain.handle(CH.pickDirectory, async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
}

async function createWindow(): Promise<void> {
  // TODO(Task 9): await sidecar.start() then load its 127.0.0.1 URL instead
  // of the placeholder below.
  mainWindow = createMainWindow(PLACEHOLDER_URL);
  hardenWindow(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
