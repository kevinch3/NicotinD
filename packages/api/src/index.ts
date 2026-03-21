import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import type { NicotinDConfig } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { ServiceManager } from '@nicotind/service-manager';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { tailscaleRoutes } from './routes/tailscale.js';
import { searchRoutes } from './routes/search.js';
import { downloadRoutes } from './routes/downloads.js';
import { libraryRoutes } from './routes/library.js';
import { streamingRoutes } from './routes/streaming.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { playlistRoutes } from './routes/playlists.js';
import { adminRoutes } from './routes/admin.js';
import { usersRoutes } from './routes/users.js';
import { subsonicProxy } from './routes/subsonic.js';
import { DownloadWatcher } from './services/download-watcher.js';
import { TailscaleService } from './services/tailscale.js';
import { ProviderRegistry } from './services/provider-registry.js';
import { NavidromeSearchProvider } from './services/providers/navidrome-provider.js';
import { SlskdSearchProvider } from './services/providers/slskd-provider.js';
import { initDatabase } from './db.js';

export type SlskdRef = { current: Slskd | null };
export type WatcherRef = { current: DownloadWatcher | null };

export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  webDistPath?: string;
  saveSecretsFn?: (username: string, password: string) => void;
}

export function createApp({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  webDistPath,
  saveSecretsFn,
}: CreateAppOptions) {
  const expandedDataDir = config.dataDir.startsWith('~')
    ? config.dataDir.replace('~', process.env.HOME ?? '/root')
    : config.dataDir;

  initDatabase(expandedDataDir);

  const app = new OpenAPIHono();

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
  app.use('*', cors());
  app.onError(errorHandler);

  // Download watcher (mutable ref — settings route can create/replace it)
  const watcherRef: WatcherRef = {
    current: slskdRef.current && config.soulseek.username && config.soulseek.password
      ? new DownloadWatcher(slskdRef.current, navidrome, {
          musicDir: config.musicDir,
          metadataFixEnabled: config.metadataFix.enabled,
          metadataFixMinScore: config.metadataFix.minScore,
        })
      : null,
  };

  // Provider registry
  const registry = new ProviderRegistry();
  registry.register(new NavidromeSearchProvider(navidrome));
  registry.register(new SlskdSearchProvider(slskdRef));

  // Tailscale service
  const tailscale = new TailscaleService();

  // Public routes
  app.route('/api/auth', authRoutes(config.jwt.secret, config.jwt.expiresIn));
  app.route(
    '/api/setup',
    setupRoutes({
      config,
      slskdRef,
      navidrome,
      serviceManager,
      watcherRef,
      tailscale,
      saveSecretsFn: saveSecretsFn ?? (() => {}),
    }),
  );

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
  app.use('/api/tailscale/*', auth);
  app.use('/api/admin/*', auth);
  app.use('/api/users/*', auth);

  app.route('/api/search', searchRoutes(registry));
  app.route('/api/admin', adminRoutes());
  app.route('/api/downloads', downloadRoutes(registry, slskdRef));
  app.route('/api/library', libraryRoutes(navidrome, config.musicDir));
  app.route('/api', streamingRoutes(navidrome));
  app.route('/api/system', systemRoutes(slskdRef, navidrome, serviceManager, config));
  app.route(
    '/api/settings',
    settingsRoutes(config, slskdRef, navidrome, serviceManager, watcherRef),
  );
  app.route('/api/playlists', playlistRoutes(navidrome));
  app.route('/api/tailscale', tailscaleRoutes(tailscale));
  app.route('/api/users', usersRoutes(registry));

  // Serve web UI static files
  if (webDistPath) {
    app.use('/assets/*', serveStatic({ root: webDistPath }));
    app.get('*', (c, next) => {
      const path = c.req.path;
      if (
        path === '/doc' ||
        path === '/openapi.json' ||
        path.startsWith('/api/') ||
        path.startsWith('/rest/')
      ) {
        return next();
      }
      return serveStatic({ root: webDistPath, path: '/index.html' })(c, next);
    });
  }

  return { app, watcherRef };
}

export { DownloadWatcher } from './services/download-watcher.js';
export { initDatabase, getDatabase } from './db.js';
