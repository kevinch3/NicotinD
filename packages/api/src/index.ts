import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import type { NicotinDConfig } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { ServiceManager } from '@nicotind/service-manager';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRoutes } from './routes/auth.js';
import { searchRoutes } from './routes/search.js';
import { downloadRoutes } from './routes/downloads.js';
import { libraryRoutes } from './routes/library.js';
import { streamingRoutes } from './routes/streaming.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { playlistRoutes } from './routes/playlists.js';
import { subsonicProxy } from './routes/subsonic.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { initDatabase } from './db.js';

export type SlskdRef = { current: Slskd | null };
export type WatcherRef = { current: DownloadWatcher | null };

export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  webDistPath?: string;
}

export function createApp({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  webDistPath,
}: CreateAppOptions) {
  const expandedDataDir = config.dataDir.startsWith('~')
    ? config.dataDir.replace('~', process.env.HOME ?? '/root')
    : config.dataDir;

  initDatabase(expandedDataDir);

  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  app.onError(errorHandler);

  // Download watcher (mutable ref — settings route can create/replace it)
  const watcherRef: WatcherRef = {
    current: slskdRef.current
      ? new DownloadWatcher(slskdRef.current, navidrome, {
          musicDir: config.musicDir,
          metadataFixEnabled: config.metadataFix.enabled,
          metadataFixMinScore: config.metadataFix.minScore,
        })
      : null,
  };

  // Public routes
  app.route('/api/auth', authRoutes(config.jwt.secret, config.jwt.expiresIn));

  // Subsonic API proxy (uses its own auth via query params)
  app.route('/rest', subsonicProxy(config));

  // Protected routes
  const auth = authMiddleware(config.jwt.secret);
  app.use('/api/search/*', auth);
  app.use('/api/downloads/*', auth);
  app.use('/api/library/*', auth);
  app.use('/api/stream/*', auth);
  app.use('/api/cover/*', auth);
  app.use('/api/system/*', auth);
  app.use('/api/settings/*', auth);
  app.use('/api/playlists/*', auth);

  app.route('/api/search', searchRoutes(slskdRef, navidrome));
  app.route('/api/downloads', downloadRoutes(slskdRef));
  app.route('/api/library', libraryRoutes(navidrome, config.musicDir));
  app.route('/api', streamingRoutes(navidrome));
  app.route('/api/system', systemRoutes(slskdRef, navidrome, serviceManager));
  app.route(
    '/api/settings',
    settingsRoutes(config, slskdRef, navidrome, serviceManager, watcherRef),
  );
  app.route('/api/playlists', playlistRoutes(navidrome));

  // Serve web UI static files
  if (webDistPath) {
    app.use('/assets/*', serveStatic({ root: webDistPath }));
    app.get('*', serveStatic({ root: webDistPath, path: '/index.html' }));
  }

  return { app, watcherRef };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { initDatabase, getDatabase } from './db.js';
