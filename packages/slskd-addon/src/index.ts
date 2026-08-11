export { createAddonApp, type AddonServerDeps } from './server.js';
export { buildManifest, ADDON_VERSION } from './manifest.js';
export { applySchema, openDatabase, getDatabase, setDatabase } from './db.js';
export { resolveConfig, storeConfig, readStoredConfig, type AddonConfig } from './config.js';

// The hunt engine — imported by @nicotind/api during the phase 1-2 transition
// (the in-process path still ships); the api dependency is severed in phase 3.
export * from './services/album-hunter.service.js';
export * from './services/track-hunter.service.js';
export * from './services/track-pick.js';
export * from './services/slskd-status.js';
export * from './services/slskd-config.js';
export * from './services/hidden-transfers.js';
export * from './services/album-fallback.service.js';
export * from './services/download-retry.service.js';
export {
  TransferPoller,
  type PolledCompletion,
  type TransferPollerOptions,
} from './services/transfer-poller.js';
