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
} as const;
