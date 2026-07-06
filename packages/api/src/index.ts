import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { serveStatic, createBunWebSocket } from 'hono/bun';
import { nativeAppCors } from './middleware/cors.js';
import type { NicotinDConfig } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ServiceManager } from '@nicotind/service-manager';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
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
import { shareMetaHandler } from './routes/share-meta.js';
import { discographyRoutes } from './routes/discography.js';
import { catalogRoutes } from './routes/catalog.js';
import { archiveRoutes } from './routes/archive.js';
import { ArchiveSearchService } from './services/archive-search.service.js';
import { spotifyRoutes } from './routes/spotify.js';
import { SpotifySearchService } from './services/spotify-search.service.js';
import { sourcesRoutes } from './routes/sources.js';
import { CandidateSearchAggregator } from './services/candidate-search.js';
import {
  AlbumHuntOrchestrator,
  ArchiveAlbumHunter,
  SpotifyAlbumHunter,
} from './services/source-hunter.js';
import { archiveToCandidate, spotifyToCandidate } from '@nicotind/core';
import { watchlistRoutes } from './routes/watchlist.js';
import { playlistRoutes } from './routes/playlists.js';
import { acquireRoutes } from './routes/acquire.js';
import { pluginRoutes } from './routes/plugins.js';
import { radioRoutes } from './routes/radio.js';
import { PluginRegistry } from './services/plugins/registry.js';
import { SlskdPlugin } from './services/plugins/slskd/index.js';
import { YtdlpPlugin } from './services/plugins/ytdlp/index.js';
import { SpotdlPlugin } from './services/plugins/spotdl/index.js';
import { ArchivePlugin } from './services/plugins/archive/index.js';
import { SpotifyPlugin } from './services/plugins/spotify/index.js';
import { LrclibPlugin } from './services/plugins/lrclib/index.js';
import { requireAcquisitionMiddleware } from './services/plugins/gate.js';
import { seedLegacyAcquisitionPlugins } from './services/plugins/legacy-seed.js';
import { AcquireWatcher } from './services/acquire-watcher.js';
import { DiscographyService } from './services/discography.service.js';
import { CatalogService } from './services/catalog-search.service.js';
import { SingleEnrichmentService } from './services/single-enrichment.service.js';
import { AlbumHunterService } from './services/album-hunter.service.js';
import { WatchlistService } from './services/watchlist.service.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { DownloadRetryService } from './services/download-retry.service.js';
import { AlbumFallbackService } from './services/album-fallback.service.js';
import { LibraryProcessingService } from './services/library-processing.service.js';
import { ProviderRegistry } from './services/provider-registry.js';
import { LibrarySearchProvider } from './services/providers/library-provider.js';
import { LibraryScanner } from './services/library-scanner.js';
import { backfillAcquisitions } from './services/acquisition-backfill.js';
import { LibraryCurator } from './services/library-curator.js';
import { LibraryOrganizer } from './services/library-organizer.js';
import { AcoustIdLookup } from './services/acoustid-lookup.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from './services/album-grouping.js';
import { createLogger } from '@nicotind/core';
import { initDatabase } from './db.js';
import { createWebSocketHandlers } from './services/websocket.js';
import type { AuthEnv } from './middleware/auth.js';

export type SlskdRef = { current: Slskd | null };
export type WatcherRef = { current: DownloadWatcher | null };
export type RetryRef = { current: DownloadRetryService | null };
export type ProcessingRef = { current: LibraryProcessingService | null };

export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  lidarr: Lidarr | null;
  serviceManager: ServiceManager;
  webDistPath?: string;
  saveSecretsFn?: (username: string, password: string) => void;
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
      // Once the library is on disk, best-effort backfill acquisition provenance
      // for songs that predate the `acquisitions` table. Runs once (guarded by a
      // library_sync_state marker); cheap no-op on subsequent boots.
      backfillAcquisitions(db);
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

  // Cross-origin support for the native (Capacitor) app — see middleware/cors.ts.
  app.use('/api/*', nativeAppCors());

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Documentation
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'NicotinD API',
      description: 'API for NicotinD — Soulseek acquisition + native music library/streaming',
    },
  });

  app.get('/doc', swaggerUI({ url: '/openapi.json' }));

  // Global middleware
  app.onError(errorHandler);

  // Shared LibraryOrganizer: moves files from any staging dir into
  // <musicDir>/<Artist>/<Album>/<NN - Title>.<ext>. Reused by both
  // DownloadWatcher (slskd) and AcquireWatcher (yt-dlp/spotdl).
  const sharedOrganizer = new LibraryOrganizer({
    musicDir: config.musicDir,
    stagingDir,
    acoustid:
      config.metadataFix.enabled && acoustidApiKey ? new AcoustIdLookup(acoustidApiKey) : undefined,
    unsortedRoot: `${expandedDataDir}/unsorted`,
    preferFlacSkipMp3: config.downloads.preferFlacSkipMp3,
    transcodeLossless: {
      enabled: config.downloads.transcodeLossless.enabled,
      bitRate: config.downloads.transcodeLossless.bitRate,
    },
    jobLookup: (directory) => {
      const exact = db
        .query<{ artist_name: string | null; album_title: string | null }, [string]>(
          `SELECT artist_name, album_title FROM album_jobs
           WHERE directory = ? AND album_title IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(directory);
      if (exact) return { artist: exact.artist_name, album: exact.album_title };

      const segments = directory.replace(/\\/g, '/').split('/').filter(Boolean);
      if (segments.length < 2) return null;
      const candidateAlbum = segments[segments.length - 1]!;
      const candidateArtist = segments[segments.length - 2]!;
      const normAlbum = normalizeForGrouping(candidateAlbum);
      const normArtist = normalizeArtistForGrouping(candidateArtist);

      const activeJobs = db
        .query<{ artist_name: string; album_title: string }, []>(
          `SELECT artist_name, album_title FROM album_jobs
           WHERE state = 'active' AND artist_name IS NOT NULL AND album_title IS NOT NULL
           ORDER BY created_at DESC LIMIT 50`,
        )
        .all();

      for (const job of activeJobs) {
        if (
          normalizeForGrouping(job.album_title) === normAlbum &&
          normalizeArtistForGrouping(job.artist_name) === normArtist
        ) {
          return { artist: job.artist_name, album: job.album_title };
        }
      }
      return null;
    },
  });

  // Download watcher (mutable ref — settings/setup routes can create/replace it).
  // Uses the shared LibraryOrganizer so slskd and yt-dlp downloads end up in the
  // same place with the same organization logic.
  const makeWatcher = (): DownloadWatcher | null => {
    if (!(slskdRef.current && config.soulseek.username && config.soulseek.password)) {
      return null;
    }
    return new DownloadWatcher(slskdRef.current, {
      musicDir: config.musicDir,
      libraryOrganizer: sharedOrganizer,
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
        autoRetryExhausted: config.downloads.autoRetryExhausted,
        exhaustedRetryCooldownMs: config.downloads.exhaustedRetryCooldownMs,
        exhaustedMaxRevives: config.downloads.exhaustedMaxRevives,
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

  // Spotify portrait lookup for the artist-image enrichment task. Bridged through
  // a ref because SpotifySearchService is constructed further down (it needs the
  // plugin registry for live creds); the scheduler only invokes this lazily during
  // a run, by which point the ref is populated.
  const spotifyArtistImageRef: { lookup: ((name: string) => Promise<string | null>) | null } = {
    lookup: null,
  };

  // Windowed library-processing scheduler — runs enrichment tasks (BPM, genre,
  // key, artist images) over the library, only inside the configured daily window.
  const processingRef: ProcessingRef = {
    current: new LibraryProcessingService({
      db,
      lidarr,
      musicDir: expandedMusicDir,
      dataDir: expandedDataDir,
      lookupArtistImageSpotify: (name) =>
        spotifyArtistImageRef.lookup?.(name) ?? Promise.resolve(null),
    }),
  };

  // Provider registry holds the always-on local library provider. The slskd
  // (network/browse/download) provider is registered/unregistered by the slskd
  // *plugin* on enable/disable — so the search network lane, downloads enqueue,
  // and user-browse gate on the plugin with no route changes.
  const registry = new ProviderRegistry();
  registry.register(new LibrarySearchProvider(db));

  // Plugin kernel — kind-agnostic enable/disable/consent/config + capability
  // resolution (default-off compliance posture: zero acquisition capability
  // until a plugin is enabled).
  const plugins = new PluginRegistry({
    db,
    dataDir: expandedDataDir,
    // Plugins report job progress through the host context; route it to the
    // acquire_jobs row (best-effort; rows without progress simply no-op).
    emitProgress: (jobId, progress) => {
      try {
        db.run(`UPDATE acquire_jobs SET progress = ? WHERE id = ?`, [
          JSON.stringify(progress),
          jobId,
        ]);
      } catch {
        // Non-fatal — progress is best-effort.
      }
    },
    emitLabel: (jobId, label) => {
      try {
        db.run(`UPDATE acquire_jobs SET label = ? WHERE id = ?`, [label, jobId]);
      } catch {
        // Non-fatal — label is best-effort.
      }
    },
  });
  plugins.register(new SlskdPlugin(slskdRef, registry));
  // Register specific-URL plugins before the catch-all yt-dlp so that
  // getEnabledForUrl's find() returns the right handler.
  // (spotdl: spotify.com only; archive: archive.org only; ytdlp: everything else)
  plugins.register(
    new SpotdlPlugin({
      enabled: config.acquire.spotdl.enabled,
      binaryPath: config.acquire.spotdl.binaryPath,
    }),
  );
  plugins.register(
    new ArchivePlugin({
      enabled: config.acquire.archive.enabled,
      preferredFormats: config.acquire.archive.preferredFormats,
    }),
  );
  // Metadata-only fallback lane — no `resolve`, so it never competes for URLs.
  plugins.register(
    new SpotifyPlugin({
      enabled: config.acquire.spotify.enabled,
      clientId: config.acquire.spotify.clientId,
      clientSecret: config.acquire.spotify.clientSecret,
    }),
  );
  plugins.register(
    new YtdlpPlugin({
      enabled: config.acquire.ytdlp.enabled,
      binaryPath: config.acquire.ytdlp.binaryPath,
      format: config.acquire.ytdlp.format,
      extraArgs: config.acquire.ytdlp.extraArgs,
    }),
  );
  // Metadata source — lyrics from LRCLIB. Default-on (keyless, benign); seeded
  // enabled on first boot only, so an admin's later disable is preserved.
  plugins.register(new LrclibPlugin());
  // One-time migration: seed the previously-implicit acquisition plugins enabled
  // ONLY on an existing (pre-plugin) install, so upgrades stay seamless. Fresh
  // installs are default-off — an admin opts into acquisition in Settings →
  // Plugins (the compliance posture). Runs exactly once (persistent marker).
  seedLegacyAcquisitionPlugins(plugins, db, {
    slskdConfigured: !!(config.soulseek.username && config.soulseek.password),
    ytdlpEnabled: config.acquire.ytdlp.enabled,
    spotdlEnabled: config.acquire.spotdl.enabled,
  });
  // Default-on metadata plugins: seed enabled idempotently (no-op once a row
  // exists), then initEnabled() activates them on this same boot.
  plugins.seedEnabled('lrclib', 'system');
  void plugins.initEnabled();

  // Reusable gate for acquisition-only features (hunt, watchlist).
  const requireAcquisition = requireAcquisitionMiddleware(plugins);

  // Public routes
  app.route(
    '/api/auth',
    authRoutes(config.jwt.secret, config.jwt.expiresIn, config.registrationEnabled),
  );
  app.route(
    '/api/setup',
    setupRoutes({
      config,
      slskdRef,
      serviceManager,
      watcherRef,
      makeWatcher,
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
  app.use('/api/admin/*', auth);
  app.use('/api/users/*', auth);
  app.use('/api/ws/*', auth);
  app.use('/api/discography/*', auth);
  app.use('/api/watchlist/*', auth);
  // Hunt + watchlist are acquisition features — gated on an enabled download
  // plugin (applied after auth so an unauthenticated caller still gets 401).
  app.use('/api/discography/*', requireAcquisition);
  app.use('/api/watchlist/*', requireAcquisition);
  app.use('/api/playlists/*', auth);
  app.use('/api/acquire/*', auth);
  app.use('/api/plugins/*', auth);
  app.use('/api/archive/*', auth);
  app.use('/api/spotify/*', auth);
  app.use('/api/sources/*', auth);

  app.get(
    '/api/ws/playback',
    upgradeWebSocket((c) => {
      const user = (c as unknown as { get(key: 'user'): AuthEnv['Variables']['user'] }).get('user');
      return createWebSocketHandlers(user.sub);
    }),
  );

  app.route('/api/search', searchRoutes(registry));
  app.route(
    '/api/admin',
    adminRoutes({
      musicDir: expandedMusicDir,
      lidarr,
      coverCacheDir: `${expandedDataDir}/cover-cache`,
      processing: processingRef.current,
    }),
  );
  app.route('/api/downloads', downloadRoutes(registry, slskdRef));
  app.route('/api/uploads', uploadRoutes(slskdRef));
  app.route(
    '/api/library',
    libraryRoutes(config.musicDir, {
      curator,
      runSync: runSyncAndCurate,
      lidarr,
      coverCacheDir: `${expandedDataDir}/cover-cache`,
      dataDir: expandedDataDir,
      pluginRegistry: plugins,
      slskdRef,
    }),
  );
  app.route('/api', streamingRoutes(expandedMusicDir, db, expandedDataDir));
  app.route(
    '/api/system',
    systemRoutes(slskdRef, serviceManager, config, { triggerScan: runSyncAndCurate }),
  );
  app.route(
    '/api/settings',
    settingsRoutes(config, slskdRef, makeWatcher, serviceManager, watcherRef),
  );
  app.route('/api/share', shareRoutes(config.jwt.secret, auth));
  app.route('/api/users', usersRoutes(registry));
  app.route('/api/playlists', playlistRoutes());
  app.route('/api/radio', radioRoutes());
  app.route('/api/plugins', pluginRoutes(plugins));
  // Metadata search sources, constructed once and shared between the legacy
  // per-source lanes and the source-agnostic blended aggregator.
  const archiveSearch = new ArchiveSearchService();
  const spotifySearch = new SpotifySearchService(() => {
    // Read the admin's current credentials live so a config edit takes effect
    // without a restart.
    const cfg = plugins.getConfig('spotify');
    return {
      clientId: (cfg.clientId as string) || config.acquire.spotify.clientId,
      clientSecret: (cfg.clientSecret as string) || config.acquire.spotify.clientSecret,
    };
  });
  // Now that the Spotify search service exists, let the artist-image enrichment
  // task reach it (no-ops gracefully when creds aren't configured).
  spotifyArtistImageRef.lookup = (name) => spotifySearch.searchArtistImage(name);
  // archive.org metadata search lane — always mounted (no Lidarr/slskd dep); the
  // route itself 503s unless the `archive` plugin is enabled.
  app.route('/api/archive', archiveRoutes({ search: archiveSearch, plugins }));
  // Spotify metadata fallback lane — downloads route to spotDL via /api/acquire.
  app.route('/api/spotify', spotifyRoutes({ search: spotifySearch, plugins }));
  // Source-agnostic blended search: every enabled metadata source mapped to the
  // unified AcquisitionCandidate shape. Adding a source = one adapter line + a
  // pure mapper (see docs/source-agnostic-acquisition.md). Soulseek stays on
  // /api/search (its polled live-progress search is blended client-side).
  const candidateAggregator = new CandidateSearchAggregator(
    [
      {
        id: 'archive',
        search: async (q) => (await archiveSearch.search(q)).map(archiveToCandidate),
      },
      {
        id: 'spotify',
        search: async (q) => (await spotifySearch.search(q)).map(spotifyToCandidate),
      },
    ],
    (id) => plugins.isEnabled(id),
  );
  app.route('/api/sources', sourcesRoutes({ aggregator: candidateAggregator }));
  // Source-agnostic album hunt across the metadata sources (Soulseek keeps its
  // specialized two-phase live search; these are the request/response sources).
  const sourceHunt = new AlbumHuntOrchestrator(
    [new ArchiveAlbumHunter(archiveSearch), new SpotifyAlbumHunter(spotifySearch)],
    (id) => plugins.isEnabled(id),
  );

  // Ingest-time enrichment of loose singles/EPs (release type + artwork). Only
  // wired when Lidarr is configured; absent → acquisition degrades to heuristic.
  let enrichSingles: ((relPaths: string[]) => Promise<void>) | undefined;

  if (lidarr && slskdRef.current) {
    const discographySvc = new DiscographyService(lidarr, db, config.musicDir);
    const hunterSvc = new AlbumHunterService(slskdRef.current);
    const catalogSvc = new CatalogService(lidarr, config.musicDir);
    const enrichmentSvc = new SingleEnrichmentService({
      db,
      catalog: catalogSvc,
      coverCacheDir: `${expandedDataDir}/cover-cache`,
    });
    enrichSingles = async (relPaths) => {
      await enrichmentSvc.enrich(relPaths);
      // Reclassify so the freshly-written release-meta takes effect immediately
      // (the incremental scan already ran with the heuristic).
      curator.reclassifyAll();
    };
    app.route(
      '/api/discography',
      discographyRoutes({
        discography: discographySvc,
        hunter: hunterSvc,
        sourceHunt,
        lidarr,
        db,
        slskdRef,
        dataDir: expandedDataDir,
      }),
    );
    app.route('/api/catalog', catalogRoutes({ catalog: catalogSvc }));

    // Watchlist auto-hunt poller — reuses the same hunter + catalog as the
    // interactive flow, so an auto-acquired album is indistinguishable from a
    // manually hunted one (same job record, same fallback recovery).
    const watchlistSvc = new WatchlistService({
      db,
      catalog: catalogSvc,
      hunter: hunterSvc,
      lidarr,
      slskdRef,
      intervalMs: config.watchlist.intervalMs,
      minMatchPct: config.watchlist.minMatchPct,
      enabled: config.watchlist.enabled,
      isAcquisitionEnabled: () => plugins.hasCapability('download'),
    });
    app.route('/api/watchlist', watchlistRoutes(watchlistSvc));
    watchlistSvc.start();
  }

  // URL-based acquisition (yt-dlp / spotdl). The watcher routes each URL to an
  // enabled resolve-capable plugin via the registry; submit 503s when none is
  // enabled/available, so no config guard is needed here.
  const acquireWatcher = new AcquireWatcher({
    db,
    dataDir: expandedDataDir,
    registry: plugins,
    organizeBatch: (files) => sharedOrganizer.organizeBatch(files),
    scanIncremental,
    enrichSingles,
  });
  app.route('/api/acquire', acquireRoutes(acquireWatcher));

  // Serve web UI static files
  if (webDistPath) {
    app.use('*', serveStatic({ root: webDistPath }));
    // Server-side OG/Twitter meta for shared links so crawlers (Slack, iMessage,
    // WhatsApp, …) render a rich preview — they don't run the SPA's JS. Must come
    // before the index.html catch-all below.
    app.get('/share/:token', shareMetaHandler({ db, jwtSecret: config.jwt.secret, webDistPath }));
    app.get('*', (c, next) => {
      const path = c.req.path;
      if (path === '/doc' || path === '/openapi.json' || path.startsWith('/api/')) {
        return next();
      }
      return serveStatic({ root: webDistPath, path: '/index.html' })(c, next);
    });
  }

  return { app, watcherRef, retryRef, processingRef, websocket };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { DownloadRetryService } from './services/download-retry.service.js';
export { initDatabase, getDatabase } from './db.js';
export { initServerSentry } from './observability/sentry.js';
