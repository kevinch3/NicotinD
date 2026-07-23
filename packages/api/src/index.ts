import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { serveStatic, createBunWebSocket } from 'hono/bun';
import { nativeAppCors } from './middleware/cors.js';
import type { NicotinDConfig, TrackStatus } from '@nicotind/core';
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
import { healthRoutes } from './routes/health.js';
import { recordBootVersion } from './services/update-check.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { adminRoutes } from './routes/admin.js';
import { feedbackRoutes } from './routes/feedback.js';
import { presenceRoutes } from './routes/presence.js';
import { usersRoutes } from './routes/users.js';
import { shareRoutes } from './routes/share.js';
import { devicesRoutes } from './routes/devices.js';
import { remoteAccessRoutes } from './routes/remote-access.js';
import { reviewRoutes } from './routes/review.js';
import { RemoteAccess } from './services/tailscale.js';
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
import { upsertTrackStatus } from './services/plugins/host-context.js';
import { recordAcquireJobTrack } from './services/acquire-playlist.js';
import { registerBuiltinPlugins } from './services/plugins/builtin.js';
import { requireAcquisitionMiddleware } from './services/plugins/gate.js';
import { seedLegacyAcquisitionPlugins } from './services/plugins/legacy-seed.js';
import { AcquireWatcher } from './services/acquire-watcher.js';
import { DiscographyService } from './services/discography.service.js';
import { CatalogService } from './services/catalog-search.service.js';
import { SingleEnrichmentService } from './services/single-enrichment.service.js';
import { AlbumHunterService } from './services/album-hunter.service.js';
import { WatchlistService } from './services/watchlist.service.js';
import { AutoAcquireService } from './services/auto-acquire.service.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { DownloadRetryService } from './services/download-retry.service.js';
import { AlbumFallbackService } from './services/album-fallback.service.js';
import { reconcileOnBoot as reconcileAcquisitionJobs } from './services/acquisition-job-store.js';
import { LibraryProcessingService } from './services/library-processing.service.js';
import { AudioFeaturesClient } from './services/audio-features-client.js';
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
import { dirname, join } from 'node:path';
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
  saveLidarrSecretsFn?: (apiKey: string) => void;
  stagingDir?: string;
  acoustidApiKey?: string;
  version?: string;
}

export function createApp({
  config,
  slskdRef,
  lidarr,
  serviceManager,
  webDistPath,
  saveSecretsFn,
  saveLidarrSecretsFn,
  stagingDir,
  acoustidApiKey,
  version,
}: CreateAppOptions) {
  const expandedDataDir = config.dataDir.startsWith('~')
    ? config.dataDir.replace('~', process.env.HOME ?? '/root')
    : config.dataDir;

  const db = initDatabase(expandedDataDir);

  // Version-history ledger: record every version this server has ever booted
  // (support: "did this DB ever run 0.1.180?"). One INSERT OR IGNORE per boot.
  if (version) recordBootVersion(db, version);

  // Startup hygiene for the unified acquisition jobs: fail items idle past the
  // 24h valve (a restart must never strand a job "downloading") and prune
  // long-finished jobs. Same contract the AcquireWatcher gives acquire_jobs.
  reconcileAcquisitionJobs(db);

  const expandedMusicDir = config.musicDir.startsWith('~')
    ? config.musicDir.replace('~', process.env.HOME ?? '/root')
    : config.musicDir;

  // Canonical-library pipeline: the native LibraryScanner reads tags off disk
  // straight into our sqlite (replacing Navidrome's async scan), LibraryCurator
  // hides/classifies. The UI reads only from these tables.
  const scanner = new LibraryScanner(expandedMusicDir, db);
  const curator = new LibraryCurator(db);
  const syncLog = createLogger('library-sync');
  // Declared here (assigned below, once its deps exist) so the incremental scan
  // seam can fire an eager processing kick the moment a download is scanned in —
  // late-bound via `.current`, evaluated at call time.
  const processingRef: ProcessingRef = { current: null };
  const runSyncAndCurate = async (): Promise<void> => {
    try {
      await scanner.scanFull();
      curator.reclassifyAll();
      // Once the library is on disk, best-effort backfill acquisition provenance
      // for songs that predate the `acquisitions` table. Runs once (guarded by a
      // library_sync_state marker); cheap no-op on subsequent boots.
      backfillAcquisitions(db);
      // Eagerly process any quarantined backlog from this scan (a fresh install,
      // or downloads that arrived while the server was down) instead of waiting
      // for the first in-window tick, so freshly-scanned music lands promptly.
      void processingRef.current?.kickEager();
    } catch (err) {
      syncLog.error({ err }, 'Library scan/curate cycle failed');
    }
  };
  // Reconcile a just-organized batch at the download→library seam: expand the
  // post-move file paths to their album folders and run an album-scoped
  // rescan + orphan-row prune, so cross-wave duplicate rows never surface (not
  // only after the next full scan). Synchronous from the caller's view — no
  // async external scanner, so no scan-timing races.
  const scanIncremental = async (relPaths: string[]): Promise<void> => {
    try {
      if (relPaths.length > 0) {
        const albumDirs = [...new Set(relPaths.map((p) => dirname(join(expandedMusicDir, p))))];
        await scanner.reconcileAlbums(albumDirs);
      }
      curator.reclassifyAll();
      // Freshly-scanned songs land quarantined (landed_at NULL). Kick an eager,
      // out-of-window processing pass so their required gate steps run now and the
      // download becomes visible as soon as it's ready — rather than waiting for
      // the next daily window. Fire-and-forget: a no-op if a run is already in
      // flight (that run graduates the new song), and never blocks the scan seam.
      void processingRef.current?.kickEager();
    } catch (err) {
      syncLog.error({ err }, 'Incremental reconcile/curate failed');
    }
  };
  // First full scan runs in the background — the UI gracefully shows an empty
  // library until it lands rather than blocking startup.
  void runSyncAndCurate();

  const app = new OpenAPIHono();
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  // Cross-origin support for the native (Capacitor) app — see middleware/cors.ts.
  app.use('/api/*', nativeAppCors());

  app.route('/api/health', healthRoutes(version));

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
    // Canonical Lidarr track titles for an album folder, so the reconciler drops
    // foreign rips (matching the scanner's canonical-aware track selection). The
    // folder is named by the canonical title (see jobLookup above), so its
    // last-two segments map back to the album_jobs artist/album.
    canonicalTitlesLookup: (dir) => {
      const segs = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      if (segs.length < 2) return null;
      const album = segs[segs.length - 1]!;
      const artist = segs[segs.length - 2]!;
      const row = db
        .query<{ canonical_tracks_json: string }, [string, string]>(
          `SELECT canonical_tracks_json FROM album_jobs
           WHERE artist_name = ? AND album_title = ? AND canonical_tracks_json IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(artist, album);
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.canonical_tracks_json);
        return Array.isArray(parsed) && parsed.length ? (parsed as string[]) : null;
      } catch {
        return null;
      }
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
            // After each retry pass, let the fallback recover given-up tracks,
            // then run acquisition-job hygiene (24h idle valve + TTL prune) so
            // a vanished transfer can never strand a job "downloading" forever.
            onSweep: fallback
              ? async () => {
                  await fallback.sweep();
                  reconcileAcquisitionJobs(db);
                }
              : () => reconcileAcquisitionJobs(db),
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

  // Analysis-sidecar client for the audio-features enrichment task; null when
  // no sidecar is configured (the task then reports itself unavailable).
  const audioFeaturesClient = config.analysis.url
    ? new AudioFeaturesClient({ baseUrl: config.analysis.url })
    : null;

  // Windowed library-processing scheduler — runs enrichment tasks (BPM, genre,
  // key, energy, audio features, artist images) over the library, only inside
  // the configured daily window.
  processingRef.current = new LibraryProcessingService({
    db,
    lidarr,
    musicDir: expandedMusicDir,
    dataDir: expandedDataDir,
    lookupArtistImageSpotify: (name) =>
      spotifyArtistImageRef.lookup?.(name) ?? Promise.resolve(null),
    audioFeaturesClient,
  });

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
    // Upsert one track's status into the job's tracks_json by title match —
    // fires once per track (many times per job), unlike the single-shot label.
    // Also upserts the acquire_job_tracks row (keyed job_id+title, position =
    // first-appearance order) that the post-ingest playlist step resolves
    // against — for EVERY event, path or not; title-only sources (spotdl)
    // rely on the title-fallback resolution of these rows.
    emitTrack: (jobId, track) => {
      try {
        const row = db
          .query<{ tracks_json: string | null }, [string]>(
            `SELECT tracks_json FROM acquire_jobs WHERE id = ?`,
          )
          .get(jobId);
        if (!row) return;
        let tracks: { title: string; status: TrackStatus; path?: string }[] = [];
        if (row.tracks_json) {
          try {
            tracks = JSON.parse(row.tracks_json);
          } catch {
            tracks = [];
          }
        }
        db.run(`UPDATE acquire_jobs SET tracks_json = ? WHERE id = ?`, [
          JSON.stringify(upsertTrackStatus(tracks, track)),
          jobId,
        ]);
        recordAcquireJobTrack(db, jobId, track);
      } catch {
        // Non-fatal — track status is best-effort.
      }
    },
  });
  registerBuiltinPlugins(plugins, {
    config,
    dataDir: expandedDataDir,
    slskdRef,
    providerRegistry: registry,
  });
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
      saveLidarrSecretsFn: saveLidarrSecretsFn ?? (() => {}),
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
  app.use('/api/presence/*', auth);
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
  app.use('/api/feedback/*', auth);

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
      dataDir: expandedDataDir,
      lidarr,
      coverCacheDir: `${expandedDataDir}/cover-cache`,
      processing: processingRef.current,
      version,
    }),
  );
  app.route('/api/feedback', feedbackRoutes());
  app.route('/api/presence', presenceRoutes());
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
      audioFeaturesClient,
    }),
  );
  app.route('/api', streamingRoutes(expandedMusicDir, db, expandedDataDir));
  app.route(
    '/api/system',
    systemRoutes(slskdRef, serviceManager, config, {
      triggerScan: runSyncAndCurate,
      version,
      musicDir: expandedMusicDir,
    }),
  );
  app.route(
    '/api/settings',
    settingsRoutes(config, slskdRef, makeWatcher, serviceManager, watcherRef),
  );
  app.route('/api/share', shareRoutes(config.jwt.secret, auth));
  // Device pairing (QR link): claim is public (the pairing token is the
  // credential), so /api/devices is deliberately NOT in the blanket-auth list —
  // pair/list/revoke apply auth per-route.
  const remoteAccess = new RemoteAccess(db);
  app.route(
    '/api/devices',
    devicesRoutes({
      jwtSecret: config.jwt.secret,
      jwtExpiresIn: config.jwt.expiresIn,
      auth,
      remoteAccess,
    }),
  );
  app.route('/api/admin/remote-access', remoteAccessRoutes(remoteAccess));
  // ServiceReview: one read-only snapshot aggregating the running service's
  // telemetry (hardware metrics, slskd state, library scan, update check,
  // backups, processing summary, jobs, audit tail, …). Admin-only; the
  // /api/admin/* blanket auth + the route's own admin check both apply.
  app.route(
    '/api/admin/review',
    reviewRoutes(slskdRef, {
      version,
      dataDir: expandedDataDir,
      processing: processingRef.current,
    }),
  );
  app.route('/api/users', usersRoutes(registry));
  app.route('/api/playlists', playlistRoutes());
  app.route('/api/radio', radioRoutes());
  app.route('/api/plugins', pluginRoutes(plugins, slskdRef));
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
        version,
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

    // Native auto-acquisition loop (opt-in): sweeps Lidarr's wanted/missing list
    // and auto-acquires each album through the same shared core as the watchlist
    // poller. Off by default — it initiates downloads unattended.
    if (config.downloads.autoAcquireEnabled) {
      const autoAcquireSvc = new AutoAcquireService({
        db,
        hunter: hunterSvc,
        lidarr,
        slskdRef,
        intervalMs: config.downloads.autoAcquireIntervalMs,
        maxPerSweep: config.downloads.autoAcquireMaxPerSweep,
        minMatchPct: config.watchlist.minMatchPct,
        isAcquisitionEnabled: () => plugins.hasCapability('download'),
      });
      autoAcquireSvc.start();
    }
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

  return { app, watcherRef, retryRef, processingRef, websocket, remoteAccess };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { DownloadRetryService } from './services/download-retry.service.js';
export { AutoAcquireService } from './services/auto-acquire.service.js';
export { initDatabase, getDatabase } from './db.js';
export { maybeCheckForUpdate } from './services/update-check.js';
// initServerSentry is intentionally NOT re-exported from the barrel: it must be
// imported via the isolated `@nicotind/api/instrument` subpath so Sentry inits
// before Hono/http modules load. See src/instrument.ts.
