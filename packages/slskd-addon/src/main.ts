import { Slskd } from '@nicotind/slskd-client';
import { createLogger, type AddonStatusRow } from '@nicotind/addon-sdk';
import { getDatabase } from './db.js';
import { resolveConfig } from './config.js';
import { createAddonApp } from './server.js';
import { AlbumHunterService } from './services/album-hunter.service.js';
import { TrackHunterService } from './services/track-hunter.service.js';
import { AlbumFallbackService } from './services/album-fallback.service.js';
import { DownloadRetryService } from './services/download-retry.service.js';
import { makeAddonFallbackHost } from './services/addon-fallback-host.js';
import { TransferPoller } from './services/transfer-poller.js';
import { markItemsCompletedByTransfer } from './services/job-store.js';
import { buildSlskdStatus } from './services/slskd-status.js';

const log = createLogger('slskd-addon');

const db = getDatabase();
let config = resolveConfig(db);

if (!config.token) {
  log.error('SLSKD_ADDON_TOKEN is not set — refusing to start without an access token');
  process.exit(1);
}

function makeSlskd(): Slskd {
  return new Slskd({
    baseUrl: config.slskdUrl,
    username: config.slskdUsername,
    password: config.slskdPassword,
  });
}

const slskdRef = { current: makeSlskd() };

// Hunt/fallback/retry engine over the addon's own tables. The fallback host
// mirrors wave events onto the protocol job ledger the core host polls.
const fallback = new AlbumFallbackService(slskdRef.current, {
  db,
  host: makeAddonFallbackHost(db),
  autoRetryExhausted: true,
});
const retry = new DownloadRetryService(slskdRef.current, {
  db,
  onSweep: () => fallback.sweep(),
});
retry.start();

// Completion tracking: resolve finished transfers to files under downloadsDir
// and mark the owning job items file-ready for GET jobs/:id/files/:itemId.
const poller = new TransferPoller(slskdRef.current, {
  db,
  rootDir: config.downloadsDir,
  onCompleted: (files) => {
    markItemsCompletedByTransfer(
      db,
      files.map((f) => ({
        username: f.username,
        filename: f.filename,
        fileReady: f.relativePath !== null,
      })),
    );
  },
});
poller.start();

async function statusRows(): Promise<AddonStatusRow[]> {
  const slskd = slskdRef.current;
  const [serverState, downloads, uploads, options, appInfo] = await Promise.all([
    slskd.server.getState().catch(() => null),
    slskd.transfers.getDownloads().catch(() => null),
    slskd.transfers.getUploads().catch(() => null),
    slskd.options.get().catch(() => null),
    slskd.application.getInfo().catch(() => null),
  ]);
  const status = buildSlskdStatus({
    enabled: true,
    available: serverState !== null,
    serverState,
    downloads,
    uploads,
    options,
    appInfo,
  });
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB/s`;
  return [
    {
      key: 'connection',
      label: 'Connection',
      value: status.connection?.isConnected ? 'Connected' : 'Disconnected',
    },
    { key: 'downloadSpeed', label: 'Download speed', value: mb(status.speeds.downloadBytesPerSec) },
    { key: 'uploadSpeed', label: 'Upload speed', value: mb(status.speeds.uploadBytesPerSec) },
    { key: 'downloading', label: 'Downloading', value: String(status.counts.downloading) },
    { key: 'queued', label: 'Queued', value: String(status.counts.queued) },
  ];
}

const app = createAddonApp({
  db,
  slskdRef,
  token: config.token,
  statusRows,
  onConfigChanged: () => {
    config = resolveConfig(db);
    slskdRef.current = makeSlskd();
    log.info('config updated — slskd client rebuilt');
  },
  engine: {
    hunter: () => new AlbumHunterService(slskdRef.current),
    trackHunter: () => new TrackHunterService(slskdRef.current),
    downloadsDir: () => config.downloadsDir,
  },
});

const port = Number(process.env.SLSKD_ADDON_PORT ?? 8585);
Bun.serve({ port, fetch: app.fetch });
log.info({ port }, 'slskd addon listening');
