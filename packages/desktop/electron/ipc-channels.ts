/**
 * Shared IPC channel-name constants used between the (non-sandboxed) main
 * process and the sandboxed preload script.
 *
 * IMPORTANT: the sandboxed preload (`preload.cts`) cannot `require`/`import`
 * this module at runtime (Electron sandboxed preloads may only
 * `require('electron')`), so its channel names are inlined there as string
 * literals. If you change a value here, update the matching literal in
 * `preload.cts` too.
 */
export const CH = {
  pickDirectory: 'nicotind:pickDirectory',
  revealLogs: 'nicotind:revealLogs',
  setMusicDir: 'nicotind:setMusicDir',
  // Renderer-driven window controls (sent from the in-app chrome bar on
  // Linux; macOS keeps the native traffic lights and never dispatches
  // these). Fire-and-forget, so the main side uses `ipcMain.on` — there's
  // no value to promise-return.
  windowMinimize: 'nicotind:window:minimize',
  windowMaximizeToggle: 'nicotind:window:maximize-toggle',
  windowClose: 'nicotind:window:close',
  // Main → renderer one-way notification when the window's maximized
  // state flips. Renderer subscribes via `onMaximizeChange(cb)` in the
  // preload so the maximize icon can swap between restore ↔ maximize.
  windowMaximizeChanged: 'nicotind:window:maximize-changed',
} as const;
