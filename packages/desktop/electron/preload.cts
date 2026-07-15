/**
 * Sandboxed Electron preload script.
 *
 * `window.ts` creates the BrowserWindow with `sandbox: true`, which means
 * this script runs in Electron's sandboxed preload context: it may only
 * `require('electron')` (or other Node built-ins Electron allow-lists for
 * sandboxed preloads) — it CANNOT `require`/`import` local project modules
 * at runtime. That's why this file is plain CommonJS (`.cts` so tsc emits
 * `.cjs`) and inlines the IPC channel-name literal below instead of
 * importing it from `./ipc-channels`.
 *
 * IMPORTANT: 'nicotind:pickDirectory' must stay in sync with
 * `CH.pickDirectory` in `ipc-channels.ts`.
 *
 * The shape exposed on `window.nicotind` here must match the web layer's
 * `NativeBridge` type (Task 4): `{ platform: 'electron', pickDirectory():
 * Promise<string | null> }`.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nicotind', {
  platform: 'electron',
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('nicotind:pickDirectory'),
});
