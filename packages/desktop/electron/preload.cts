/**
 * Sandboxed Electron preload script.
 *
 * `window.ts` creates the BrowserWindow with `sandbox: true`, which means
 * this script runs in Electron's sandboxed preload context: it may only
 * `require('electron')` (or other Node built-ins Electron allow-lists for
 * sandboxed preloads) — it CANNOT `require`/`import` local project modules
 * at runtime. That's why this file is plain CommonJS (`.cts` so tsc emits
 * `.cjs`) and inlines IPC channel-name literals below instead of importing
 * them from `./ipc-channels`.
 *
 * IMPORTANT: channel-name string literals must stay in sync with `CH` in
 * `ipc-channels.ts`.
 *
 * The shape exposed on `window.nicotind` here must match the web layer's
 * `NativeBridge` type (see `packages/web/src/app/services/native/
 * native-capabilities.ts`): `{ platform: 'electron', os: NodeJS.Platform,
 * pickDirectory(), setMusicDir(path, opts?), revealLogs(), minimize(),
 * maximizeToggle(), close(), onMaximizeChange(cb) }`. Fire-and-forget
 * window controls use `ipcRenderer.send`; everything with a return value
 * uses `ipcRenderer.invoke`.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Synchronous snapshot of the host OS, captured here because the sandboxed
 * preload can't `process` from outside this script. Surfaced on
 * `window.nicotind.os` so renderer code can branch on macOS vs. Linux
 * without an extra round-trip (used by the layout header to render the
 * in-app window controls only on Linux).
 */
const OS = process.platform;

contextBridge.exposeInMainWorld('nicotind', {
  platform: 'electron',
  os: OS,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('nicotind:pickDirectory'),
  setMusicDir: (path: string, opts?: { restart?: boolean }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('nicotind:setMusicDir', path, opts),
  revealLogs: (): Promise<void> => ipcRenderer.invoke('nicotind:revealLogs'),

  // Window-control channels dispatched from the renderer's in-app chrome
  // bar (the `data-electron-title-bar` element on Linux). Fire-and-forget:
  // main acks only when a state-change happens back to the renderer.
  minimize: (): void => {
    ipcRenderer.send('nicotind:window:minimize');
  },
  maximizeToggle: (): void => {
    ipcRenderer.send('nicotind:window:maximize-toggle');
  },
  close: (): void => {
    ipcRenderer.send('nicotind:window:close');
  },

  /**
   * Subscribes to maximize-state-change pushes from main. Returns an
   * unsubscribe function — Angular `OnDestroy` calls it on component
   * teardown so we don't leak IPC listeners across hot reloads / route
   * changes. `ipcRenderer.on` is allow-listed for sandboxed preloads.
   */
  onMaximizeChange: (cb: (state: { isMaximized: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { isMaximized: boolean }): void => {
      cb(state);
    };
    ipcRenderer.on('nicotind:window:maximize-changed', listener);
    return () => {
      ipcRenderer.removeListener('nicotind:window:maximize-changed', listener);
    };
  },
});
