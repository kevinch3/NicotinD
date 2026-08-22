// Must be first: initializes Sentry before Hono/http modules load (see instrument.ts).
import { sentryEnabled } from './instrument.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import pkg from '../package.json';
import { NicotinDConfigSchema, createLogger, generateSecret, resolvePort } from '@nicotind/core';
import { ServiceManager, NativeProcessStrategy } from '@nicotind/service-manager';
import { Lidarr } from '@nicotind/lidarr-client';
import { createApp, findInsecureDefaults, getDatabase, maybeCheckForUpdate } from '@nicotind/api';

const log = createLogger('nicotind');

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

async function main() {
  // Sentry was initialized at process load (instrument.ts); just report state here.
  if (sentryEnabled) log.info('Sentry error tracking enabled');

  log.info('Starting NicotinD...');

  // 1. Load configuration
  const config = loadConfig();
  log.info(
    { port: config.port, mode: config.mode, musicDir: config.musicDir },
    'Configuration loaded',
  );

  // 2. Start sub-services (if embedded mode)
  const strategy = new NativeProcessStrategy();
  const serviceManager = new ServiceManager(strategy, config);
  const startupSecrets = loadOrCreateSecrets(config.dataDir);

  if (config.mode === 'embedded') {
    // Auto-download binaries if missing
    const dataDir = config.dataDir.startsWith('~')
      ? join(process.env.HOME ?? '/root', config.dataDir.slice(1))
      : config.dataDir;
    const binDir = join(dataDir, 'bin');
    const lidarrBin = join(binDir, 'Lidarr', 'Lidarr');

    // Lidarr is optional; its download is best-effort inside download-deps.
    // (slskd is the addon's business since phase 3 — nothing to download here.)
    const needsLidarr = !!config.lidarr && !existsSync(lidarrBin);

    if (needsLidarr) {
      log.info('Downloading dependencies (first run)...');
      const { execSync } = await import('node:child_process');
      execSync(`bun run ${resolve(import.meta.dir, '../scripts/download-deps.ts')}`, {
        stdio: 'inherit',
      });
    }

    log.info('Embedded mode — starting services...');
    // Only start Lidarr if its binary is actually present — avoids a slow,
    // doomed health-check wait when the (best-effort) download didn't land.
    if (config.lidarr && existsSync(lidarrBin)) {
      await serviceManager.startLidarr(startupSecrets.lidarrApiKey);
    } else if (config.lidarr) {
      log.info('Lidarr binary not present — discography features disabled (embedded)');
    }
  }

  // 3. Initialize clients
  const lidarr = config.lidarr
    ? new Lidarr({ baseUrl: config.lidarr.url, apiKey: config.lidarr.apiKey })
    : null;

  if (lidarr) {
    try {
      const rootFolders = await lidarr.artist.getRootFolders();
      if (rootFolders.length === 0) {
        await lidarr.artist.addRootFolder(config.musicDir);
        log.info({ path: config.musicDir }, 'Registered music dir as Lidarr root folder');
      }
    } catch (err) {
      log.warn(
        { err },
        'Lidarr root folder provisioning failed — discography may not work until Lidarr is reachable',
      );
    }
  }

  // 4. Create and start API server
  // NICOTIND_WEB_DIST override: in a packaged desktop build the SPA is staged under
  // the app's resources dir, and a `bun --compile`/relocated entry can't resolve
  // `import.meta.dir` to the repo layout (it points at /$bunfs/root). Falls back to the
  // repo-relative path for normal `bun run` / server / Docker.
  const webDistPath =
    process.env.NICOTIND_WEB_DIST ?? resolve(import.meta.dir, '../packages/web/dist');

  const { app, processingRef, websocket, remoteAccess } = createApp({
    config,
    lidarr,
    serviceManager,
    webDistPath,
    saveLidarrSecretsFn: (apiKey: string) => {
      const currentSecrets = loadOrCreateSecrets(config.dataDir);
      currentSecrets.lidarrApiKey = apiKey;
      saveSecrets(config.dataDir, currentSecrets);
    },
    // URL-acquire plugins stage downloads here before the organizer ingests
    // them (the slskd-specific staging path died with the in-process client).
    stagingDir: join(
      config.dataDir.startsWith('~')
        ? join(process.env.HOME ?? '/root', config.dataDir.slice(1))
        : config.dataDir,
      'downloads',
    ),
    acoustidApiKey: startupSecrets.acoustidApiKey,
    version: pkg.version,
  });

  if (processingRef.current) processingRef.current.start();

  const server = Bun.serve({
    port: config.port, // 0 => OS-assigned ephemeral port
    // Default preserves today's behavior (0.0.0.0, reachable via Docker port mapping).
    // The desktop sidecar sets NICOTIND_BIND_HOST=127.0.0.1 to bind loopback-only.
    hostname: process.env.NICOTIND_BIND_HOST || undefined,
    // Bun's default is 10s, which is too tight for interactive routes that make a
    // synchronous Lidarr + rate-limited Discogs round-trip (artist-info refresh,
    // metadata optimize, discography lookups) — those were being aborted mid-flight
    // ("request timed out after 10 seconds"), so an artist bio never came back.
    idleTimeout: 60,
    fetch: app.fetch,
    websocket,
  });
  // Machine-readable handshake for the desktop supervisor. Keep the exact prefix.
  log.info({ port: server.port }, 'NicotinD is ready');
  console.log(`NICOTIND_LISTENING ${server.port}`);

  // Shipped defaults that are unsafe and are being removed (#612). Warn-only on
  // purpose: this image is public, so these defaults are what strangers run, and
  // one of them is load-bearing for someone's install. Announce, then enforce.
  // Logged after `ready` so a noisy warning can never be mistaken for a boot
  // failure, and never fatal — an advisory that stops a boot is a worse bug than
  // the thing it warns about.
  try {
    for (const d of findInsecureDefaults(getDatabase())) {
      log.warn({ deprecation: d.code }, d.message);
    }
  } catch (err) {
    log.debug({ err }, 'insecure-defaults check skipped');
  }

  // Remote access (Tailscale Funnel): the funnel target port is only known now,
  // so arm here — non-fatal on failure, state surfaced via the admin route.
  if (server.port !== undefined) void remoteAccess.onServerStarted(server.port);

  // Daily update check (GitHub releases poll, cached in the DB; the admin
  // route serves the cache). The guard self-limits to one poll per 24h with a
  // 1h failure backoff, so an hourly kick is just a scheduler. Opt-out via
  // NICOTIND_UPDATE_CHECK=off. Lives here (not the processor tick) so route/
  // service unit tests can never trigger a network call.
  void maybeCheckForUpdate(getDatabase());
  setInterval(() => void maybeCheckForUpdate(getDatabase()), 3_600_000).unref();

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    if (processingRef.current) processingRef.current.stop();
    await serviceManager.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export interface PersistedSecrets {
  lidarrApiKey: string;
  jwtSecret: string;
  acoustidApiKey?: string;
}

export function loadOrCreateSecrets(dataDir: string): PersistedSecrets {
  const dir = dataDir.startsWith('~')
    ? join(process.env.HOME ?? '/root', dataDir.slice(1))
    : dataDir;
  mkdirSync(dir, { recursive: true });
  const secretsPath = join(dir, 'secrets.json');

  if (existsSync(secretsPath)) {
    return JSON.parse(readFileSync(secretsPath, 'utf-8'));
  }

  const secrets: PersistedSecrets = {
    lidarrApiKey: generateSecret(24),
    jwtSecret: generateSecret(32),
  };
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  log.info('Generated and saved internal secrets');
  return secrets;
}

export function saveSecrets(dataDir: string, secrets: PersistedSecrets): void {
  const dir = dataDir.startsWith('~')
    ? join(process.env.HOME ?? '/root', dataDir.slice(1))
    : dataDir;
  mkdirSync(dir, { recursive: true });
  const secretsPath = join(dir, 'secrets.json');
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

function loadConfig() {
  // Try loading config file
  let fileConfig = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    fileConfig = parse(raw) ?? {};
  } catch {
    log.info('No config file found, using environment variables and defaults');
  }

  const dataDir =
    process.env.NICOTIND_DATA_DIR ||
    ((fileConfig as Record<string, unknown>).dataDir as string) ||
    '~/.nicotind';
  const secrets = loadOrCreateSecrets(dataDir);
  const metadataFixEnabled = parseBooleanEnv(process.env.NICOTIND_METADATA_FIX_ENABLED);

  // Merge: file config < persisted secrets < env vars
  const merged = {
    ...fileConfig,
    port: resolvePort(
      process.env.NICOTIND_PORT,
      (fileConfig as Record<string, unknown>).port as number,
    ),
    dataDir: process.env.NICOTIND_DATA_DIR || (fileConfig as Record<string, unknown>).dataDir,
    musicDir: process.env.NICOTIND_MUSIC_DIR || (fileConfig as Record<string, unknown>).musicDir,
    mode: process.env.NICOTIND_MODE || (fileConfig as Record<string, unknown>).mode,
    // Deployment-wide acquisition kill-switch (#235): env `NICOTIND_ACQUISITION`
    // (off/false/0/no → disabled) overrides the file config; unset falls through
    // to the file value / schema default (on).
    ...(parseBooleanEnv(process.env.NICOTIND_ACQUISITION) !== undefined
      ? { acquisitionEnabled: parseBooleanEnv(process.env.NICOTIND_ACQUISITION) }
      : {}),
    // Listening-history kill-switch (#454), same env-as-hard-floor semantics.
    ...(parseBooleanEnv(process.env.NICOTIND_HISTORY) !== undefined
      ? { historyEnabled: parseBooleanEnv(process.env.NICOTIND_HISTORY) }
      : {}),
    metadataFix: {
      ...((fileConfig as Record<string, unknown>).metadataFix as Record<string, unknown>),
      ...(metadataFixEnabled !== undefined ? { enabled: metadataFixEnabled } : {}),
      ...(process.env.NICOTIND_METADATA_FIX_MIN_SCORE
        ? { minScore: Number(process.env.NICOTIND_METADATA_FIX_MIN_SCORE) }
        : {}),
    },
    downloads: {
      ...((fileConfig as Record<string, unknown>).downloads as Record<string, unknown>),
      ...(process.env.NICOTIND_AUTO_RETRY_ENABLED
        ? { autoRetryEnabled: parseBooleanEnv(process.env.NICOTIND_AUTO_RETRY_ENABLED) }
        : {}),
      ...(process.env.NICOTIND_AUTO_ACQUIRE_ENABLED
        ? { autoAcquireEnabled: parseBooleanEnv(process.env.NICOTIND_AUTO_ACQUIRE_ENABLED) }
        : {}),
      ...(process.env.NICOTIND_RETRY_MAX_ATTEMPTS
        ? { retryMaxAttempts: Number(process.env.NICOTIND_RETRY_MAX_ATTEMPTS) }
        : {}),
      ...(process.env.NICOTIND_RETRY_INTERVAL_MS
        ? { retryIntervalMs: Number(process.env.NICOTIND_RETRY_INTERVAL_MS) }
        : {}),
      ...(process.env.NICOTIND_RETRY_COOLDOWN_MS
        ? { retryCooldownMs: Number(process.env.NICOTIND_RETRY_COOLDOWN_MS) }
        : {}),
      ...(process.env.NICOTIND_FALLBACK_MAX_ATTEMPTS
        ? { fallbackMaxAttempts: Number(process.env.NICOTIND_FALLBACK_MAX_ATTEMPTS) }
        : {}),
      ...(process.env.NICOTIND_PREFER_FLAC_SKIP_MP3
        ? { preferFlacSkipMp3: parseBooleanEnv(process.env.NICOTIND_PREFER_FLAC_SKIP_MP3) }
        : {}),
      ...(process.env.NICOTIND_TRANSCODE_LOSSLESS_ENABLED ||
      process.env.NICOTIND_TRANSCODE_LOSSLESS_BITRATE
        ? {
            transcodeLossless: {
              ...(((fileConfig as Record<string, unknown>).downloads as Record<string, unknown>)
                ?.transcodeLossless as Record<string, unknown>),
              ...(process.env.NICOTIND_TRANSCODE_LOSSLESS_ENABLED
                ? { enabled: parseBooleanEnv(process.env.NICOTIND_TRANSCODE_LOSSLESS_ENABLED) }
                : {}),
              ...(process.env.NICOTIND_TRANSCODE_LOSSLESS_BITRATE
                ? { bitRate: Number(process.env.NICOTIND_TRANSCODE_LOSSLESS_BITRATE) }
                : {}),
            },
          }
        : {}),
    },
    acquire: {
      ...((fileConfig as Record<string, unknown>).acquire as Record<string, unknown>),
      // Optional env seeding of the Spotify metadata-lane credentials (Docker /
      // headless). The admin Settings → Plugins form is the primary path.
      ...(process.env.SPOTIFY_CLIENT_ID || process.env.SPOTIFY_CLIENT_SECRET
        ? {
            spotify: {
              ...(((fileConfig as Record<string, unknown>).acquire as Record<string, unknown>)
                ?.spotify as Record<string, unknown>),
              ...(process.env.SPOTIFY_CLIENT_ID ? { clientId: process.env.SPOTIFY_CLIENT_ID } : {}),
              ...(process.env.SPOTIFY_CLIENT_SECRET
                ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
                : {}),
            },
          }
        : {}),
    },
    lidarr: {
      url: 'http://localhost:8686',
      port: 8686,
      apiKey: secrets.lidarrApiKey,
      ...((fileConfig as Record<string, unknown>).lidarr as Record<string, unknown>),
      ...(process.env.NICOTIND_LIDARR_URL ? { url: process.env.NICOTIND_LIDARR_URL } : {}),
      ...(process.env.LIDARR_API_KEY ? { apiKey: process.env.LIDARR_API_KEY } : {}),
    },
    analysis: {
      url: '',
      ...((fileConfig as Record<string, unknown>).analysis as Record<string, unknown>),
      ...(process.env.NICOTIND_ANALYSIS_URL ? { url: process.env.NICOTIND_ANALYSIS_URL } : {}),
    },
    jwt: {
      secret: secrets.jwtSecret,
      expiresIn: '30d',
      ...((fileConfig as Record<string, unknown>).jwt as Record<string, unknown>),
      ...(process.env.NICOTIND_JWT_SECRET ? { secret: process.env.NICOTIND_JWT_SECRET } : {}),
    },
  };

  return NicotinDConfigSchema.parse(merged);
}

main().catch((err) => {
  log.fatal({ err }, 'Failed to start NicotinD');
  process.exit(1);
});
