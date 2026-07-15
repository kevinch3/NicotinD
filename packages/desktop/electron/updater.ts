import { app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { updateMode } from './update-mode.js';

export { updateMode } from './update-mode.js';

const RELEASES_URL = 'https://github.com/kevinch3/NicotinD/releases/latest';

/**
 * Wires `electron-updater` into the app's lifecycle. No-ops in dev (there's
 * no packaged app / GitHub release to check against). Errors from the
 * update check are caught and logged — a failed update check must never
 * crash or otherwise disrupt the running app.
 */
export function initAutoUpdate(opts?: { signed?: boolean }): void {
  if (!app.isPackaged) {
    return;
  }

  try {
    const mode = updateMode(process.platform, opts?.signed ?? false);

    if (mode === 'apply') {
      initApplyMode();
    } else {
      initNotifyMode();
    }
  } catch (err) {
    console.error('Auto-update check failed to initialize', err);
  }
}

/** Linux (AppImage): download in the background, prompt, install on confirm. */
function initApplyMode(): void {
  autoUpdater.autoDownload = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `NicotinD ${info.version} has been downloaded.`,
        detail: 'Restart now to install it?',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to show update-ready dialog', err);
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error', err);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    console.error('checkForUpdatesAndNotify failed', err);
  });
}

/**
 * Unsigned macOS: never let electron-updater attempt to apply an update
 * (it can't, and shouldn't try). Only fetch latest-version metadata and, if
 * newer than the running app, point the user at the Releases page.
 */
function initNotifyMode(): void {
  autoUpdater.autoDownload = false;

  autoUpdater.on('update-available', (info) => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `NicotinD ${info.version} is available.`,
        detail: 'This build cannot auto-install updates. Open the download page?',
        buttons: ['Open Releases page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          void shell.openExternal(RELEASES_URL);
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to show update-available dialog', err);
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error', err);
  });

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('checkForUpdates failed', err);
  });
}
