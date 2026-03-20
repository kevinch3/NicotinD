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
import { subsonicProxy } from './routes/subsonic.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { initDatabase } from './db.js';

export interface CreateAppOptions {
  config: NicotinDConfig;
  slskd: Slskd;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  webDistPath?: string;
}

export function createApp({ config, slskd, navidrome, serviceManager, webDistPath }: CreateAppOptions) {
  const expandedDataDir = config.dataDir.startsWith('~')
    ? config.dataDir.replace('~', process.env.HOME ?? '/root')
    : config.dataDir;

  initDatabase(expandedDataDir);

  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  app.onError(errorHandler);

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

  app.route('/api/search', searchRoutes(slskd, navidrome));
  app.route('/api/downloads', downloadRoutes(slskd));
  app.route('/api/library', libraryRoutes(navidrome));
  app.route('/api', streamingRoutes(navidrome));
  app.route('/api/system', systemRoutes(slskd, navidrome, serviceManager));

  // Serve web UI static files
  if (webDistPath) {
    app.use('/assets/*', serveStatic({ root: webDistPath }));
    app.get('*', serveStatic({ root: webDistPath, path: '/index.html' }));
  }

  // Download watcher
  const watcher = new DownloadWatcher(slskd, navidrome);

  return { app, watcher };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { initDatabase, getDatabase } from './db.js';
