import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { serveStatic, createBunWebSocket } from 'hono/bun';
import type { NicotinDConfig } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ServiceManager } from '@nicotind/service-manager';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { tailscaleRoutes } from './routes/tailscale.js';
import { searchRoutes } from './routes/search.js';
import { downloadRoutes } from './routes/downloads.js';
import { uploadRoutes } from './routes/uploads.js';
import { libraryRoutes } from './routes/library.js';
import { streamingRoutes } from './routes/streaming.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { adminRoutes } from './routes/admin.js';
import { usersRoutes } from './routes/users.js';
import { shareRoutes } from './routes/share.js';
import { discographyRoutes } from './routes/discography.js';
import { catalogRoutes } from './routes/catalog.js';
import { DiscographyService } from './services/discography.service.js';
import { CatalogService } from './services/catalog-search.service.js';
import { AlbumHunterService } from './services/album-hunter.service.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { DownloadRetryService } from './services/download-retry.service.js';
import { AlbumFallbackService } from './services/album-fallback.service.js';
import { TailscaleService } from './services/tailscale.js';
import { ProviderRegistry } from './services/provider-registry.js';
import { LibrarySearchProvider } from './services/providers/library-provider.js';
import { SlskdSearchProvider } from './services/providers/slskd-provider.js';
import { LibraryScanner } from './services/library-scanner.js';
import { LibraryCurator } from './services/library-curator.js';
import { createLogger } from '@nicotind/core';
import { initDatabase } from './db.js';
import { createWebSocketHandlers } from './services/websocket.js';
import type { AuthEnv } from './middleware/auth.js';

export type SlskdRef = { current: Slskd | null };
export type WatcherRef = { current: DownloadWatcher | null };
export type RetryRef = { current: DownloadRetryService | null };

export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  lidarr: Lidarr | null;
  serviceManager: ServiceManager;
  webDistPath?: string;
  saveSecretsFn?: (username: string, password: string) => void;
  tailscale?: TailscaleService;
  saveTailscaleAuthKeyFn?: (key: string) => void;
  clearTailscaleAuthKeyFn?: () => void;
  stagingDir?: string;
  acoustidApiKey?: string;
}

export function createApp({
  config,
  slskdRef,
  lidarr,
  serviceManager,
  webDistPath,
  saveSecretsFn,
  tailscale: tailscaleOption,
  saveTailscaleAuthKeyFn,
  clearTailscaleAuthKeyFn,
  stagingDir,
  acoustidApiKey,
}: CreateAppOptions) {
  const expandedDataDir = config.dataDir.startsWith('~')
    ? config.dataDir.replace('~', process.env.HOME ?? '/root')
    : config.dataDir;

  const db = initDatabase(expandedDataDir);

  const expandedMusicDir = config.musicDir.startsWith('~')
    ? config.musicDir.replace('~', process.env.HOME ?? '/root')
    : config.musicDir;

  // Canonical-library pipeline: the native LibraryScanner reads tags off disk
  // straight into our sqlite (replacing Navidrome's async scan), LibraryCurator
  // hides/classifies. The UI reads only from these tables.
  const scanner = new LibraryScanner(expandedMusicDir, db);
  const curator = new LibraryCurator(db);
  const syncLog = createLogger('library-sync');
  const runSyncAndCurate = async (): Promise<void> => {
    try {
      await scanner.scanFull();
      curator.reclassifyAll();
    } catch (err) {
      syncLog.error({ err }, 'Library scan/curate cycle failed');
    }
  };
  // Incremental scan of a just-organized batch (post-download). Synchronous from
  // the caller's view — no async external scanner, so no scan-timing races.
  const scanIncremental = async (relPaths: string[]): Promise<void> => {
    try {
      await scanner.scanPaths(relPaths);
      curator.reclassifyAll();
    } catch (err) {
      syncLog.error({ err }, 'Incremental scan/curate failed');
    }
  };
  // First full scan runs in the background — the UI gracefully shows an empty
  // library until it lands rather than blocking startup.
  void runSyncAndCurate();

  const app = new OpenAPIHono();
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Documentation
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'NicotinD API',
      description: 'API for NicotinD Soulseek/Navidrome client',
    },
  });

  app.get('/doc', swaggerUI({ url: '/openapi.json' }));

  // Global middleware
  app.onError(errorHandler);

  // Download watcher (mutable ref — settings/setup routes can create/replace it).
  // The watcher owns a LibraryOrganizer that moves files from slskd's staging
  // dir into <musicDir>/<Artist>/<Album>/<NN - Title>.<ext>, then drives the
  // native scanner over the organized files.
  const makeWatcher = (): DownloadWatcher | null => {
    if (!(slskdRef.current && config.soulseek.username && config.soulseek.password)) {
      return null;
    }
    return new DownloadWatcher(slskdRef.current, {
      musicDir: config.musicDir,
      stagingDir,
      acoustidApiKey: config.metadataFix.enabled ? acoustidApiKey : undefined,
      // Park unsortable files outside musicDir so they aren't indexed.
      unsortedRoot: `${expandedDataDir}/unsorted`,
      preferFlacSkipMp3: config.downloads.preferFlacSkipMp3,
      // Index the freshly organized files into the canonical library.
      scan: scanIncremental,
    });
  };
  const watcherRef: WatcherRef = { current: makeWatcher() };

  // Self-healing retry reconciler — re-enqueues failed slskd transfers (slskd
  // resumes the partial file) and, once attempts exhaust, hands off to the
  // cross-peer fallback layer that pulls the missing tracks from another peer.
  const fallback = slskdRef.current
    ? new AlbumFallbackService(slskdRef.current, {
        db,
        maxFallbackAttempts: config.downloads.fallbackMaxAttempts,
      })
    : null;
  const retryRef: RetryRef = {
    current:
      slskdRef.current && config.downloads.autoRetryEnabled
        ? new DownloadRetryService(slskdRef.current, {
            db,
            intervalMs: config.downloads.retryIntervalMs,
            maxAttempts: config.downloads.retryMaxAttempts,
            cooldownMs: config.downloads.retryCooldownMs,
            // After each retry pass, let the fallback recover given-up tracks.
            onSweep: fallback ? () => fallback.sweep() : undefined,
          })
        : null,
  };

  // Provider registry
  const registry = new ProviderRegistry();
  registry.register(new LibrarySearchProvider(db));
  registry.register(new SlskdSearchProvider(slskdRef));

  // Tailscale service — reuse the instance from main.ts if provided (avoids duplicate state)
  const tailscale = tailscaleOption ?? new TailscaleService();

  // Public routes
  app.route('/api/auth', authRoutes(config.jwt.secret, config.jwt.expiresIn, config.registrationEnabled));
  app.route(
    '/api/setup',
    setupRoutes({
      config,
      slskdRef,
      serviceManager,
      watcherRef,
      makeWatcher,
      tailscale,
      saveSecretsFn: saveSecretsFn ?? (() => {}),
    }),
  );

  // Protected routes
  const auth = authMiddleware(config.jwt.secret);
  app.use('/api/search/*', auth);
  app.use('/api/downloads/*', auth);
  app.use('/api/uploads/*', auth);
  app.use('/api/library/*', auth);
  app.use('/api/stream/*', auth);
  app.use('/api/cover/*', auth);
  app.use('/api/system/*', auth);
  app.use('/api/settings/*', auth);
  app.use('/api/tailscale/*', auth);
  app.use('/api/admin/*', auth);
  app.use('/api/users/*', auth);
  app.use('/api/ws/*', auth);
  app.use('/api/discography/*', auth);

  app.get('/api/ws/playback', upgradeWebSocket((c) => {
    const user = (c as unknown as { get(key: 'user'): AuthEnv['Variables']['user'] }).get('user');
    return createWebSocketHandlers(user.sub);
  }));

  app.route('/api/search', searchRoutes(registry));
  app.route('/api/admin', adminRoutes());
  app.route('/api/downloads', downloadRoutes(registry, slskdRef));
  app.route('/api/uploads', uploadRoutes(slskdRef));
  app.route('/api/library', libraryRoutes(config.musicDir, { curator, runSync: runSyncAndCurate }));
  app.route('/api', streamingRoutes(expandedMusicDir, db, expandedDataDir));
  app.route('/api/system', systemRoutes(slskdRef, serviceManager, config, { triggerScan: runSyncAndCurate }));
  app.route(
    '/api/settings',
    settingsRoutes(config, slskdRef, makeWatcher, serviceManager, watcherRef),
  );
  app.route('/api/share', shareRoutes(config.jwt.secret, auth));
  app.route('/api/tailscale', tailscaleRoutes(tailscale, saveTailscaleAuthKeyFn, clearTailscaleAuthKeyFn));
  app.route('/api/users', usersRoutes(registry));

  if (lidarr && slskdRef.current) {
    const discographySvc = new DiscographyService(lidarr, db, config.musicDir);
    const hunterSvc = new AlbumHunterService(slskdRef.current);
    app.route(
      '/api/discography',
      discographyRoutes({
        discography: discographySvc,
        hunter: hunterSvc,
        lidarr,
        db,
        slskdRef,
        dataDir: expandedDataDir,
      }),
    );
    app.route('/api/catalog', catalogRoutes({ catalog: new CatalogService(lidarr, config.musicDir) }));
  }

  // Serve web UI static files
  if (webDistPath) {
    app.use('*', serveStatic({ root: webDistPath }));
    app.get('*', (c, next) => {
      const path = c.req.path;
      if (
        path === '/doc' ||
        path === '/openapi.json' ||
        path.startsWith('/api/')
      ) {
        return next();
      }
      return serveStatic({ root: webDistPath, path: '/index.html' })(c, next);
    });
  }

  return { app, watcherRef, retryRef, websocket };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { DownloadRetryService } from './services/download-retry.service.js';
export { initDatabase, getDatabase } from './db.js';
export { TailscaleService } from './services/tailscale.js';
