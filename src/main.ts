// Must be first: initializes Sentry before Hono/http modules load (see instrument.ts).
import { sentryEnabled } from './instrument.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { NicotinDConfigSchema, createLogger, generateSecret } from '@nicotind/core';
import { ServiceManager, NativeProcessStrategy } from '@nicotind/service-manager';
import { Slskd } from '@nicotind/slskd-client';
import { Lidarr } from '@nicotind/lidarr-client';
import { createApp } from '@nicotind/api';

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

  const hasSoulseekCreds = !!(config.soulseek.username && config.soulseek.password);

  if (config.mode === 'embedded') {
    // Auto-download binaries if missing
    const dataDir = config.dataDir.startsWith('~')
      ? join(process.env.HOME ?? '/root', config.dataDir.slice(1))
      : config.dataDir;
    const binDir = join(dataDir, 'bin');
    const slskdBin = join(binDir, 'slskd');
    const lidarrBin = join(binDir, 'Lidarr', 'Lidarr');

    // Only require slskd binary if Soulseek credentials are configured
    const needsSlskd = hasSoulseekCreds && !existsSync(slskdBin);
    // Lidarr is optional; its download is best-effort inside download-deps.
    const needsLidarr = !!config.lidarr && !existsSync(lidarrBin);

    if (needsSlskd || needsLidarr) {
      log.info('Downloading dependencies (first run)...');
      const { execSync } = await import('node:child_process');
      execSync(`bun run ${resolve(import.meta.dir, '../scripts/download-deps.ts')}`, {
        stdio: 'inherit',
      });
    }

    log.info('Embedded mode — starting services...');
    if (hasSoulseekCreds) {
      await serviceManager.startSlskd();
    } else {
      log.info('No Soulseek credentials configured — skipping slskd (network search disabled)');
      log.info('Configure credentials in Settings to enable Soulseek network search');
    }
    // Only start Lidarr if its binary is actually present — avoids a slow,
    // doomed health-check wait when the (best-effort) download didn't land.
    if (config.lidarr && existsSync(lidarrBin)) {
      await serviceManager.startLidarr(startupSecrets.lidarrApiKey);
    } else if (config.lidarr) {
      log.info('Lidarr binary not present — discography features disabled (embedded)');
    }
  }

  // 3. Initialize clients (slskd wrapped in mutable ref for hot-swap via settings)
  const slskdRef: { current: Slskd | null } = {
    current: new Slskd({
      baseUrl: config.slskd.url,
      username: config.slskd.username,
      password: config.slskd.password,
    }),
  };

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
  const webDistPath = resolve(import.meta.dir, '../packages/web/dist');

  const { app, watcherRef, retryRef, processingRef, websocket } = createApp({
    config,
    slskdRef,
    lidarr,
    serviceManager,
    webDistPath,
    saveSecretsFn: (username: string, password: string) => {
      const currentSecrets = loadOrCreateSecrets(config.dataDir);
      currentSecrets.soulseekUsername = username;
      currentSecrets.soulseekPassword = password;
      saveSecrets(config.dataDir, currentSecrets);
    },
    stagingDir: join(
      config.dataDir.startsWith('~')
        ? join(process.env.HOME ?? '/root', config.dataDir.slice(1))
        : config.dataDir,
      'slskd',
      'downloads',
    ),
    acoustidApiKey: startupSecrets.acoustidApiKey,
  });

  if (watcherRef.current) watcherRef.current.start();
  if (retryRef.current) retryRef.current.start();
  if (processingRef.current) processingRef.current.start();

  log.info({ port: config.port }, 'NicotinD is ready');

  Bun.serve({
    port: config.port,
    fetch: app.fetch,
    websocket,
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down...');
    if (watcherRef.current) watcherRef.current.stop();
    if (retryRef.current) retryRef.current.stop();
    if (processingRef.current) processingRef.current.stop();
    await serviceManager.stopAll();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    if (watcherRef.current) watcherRef.current.stop();
    if (retryRef.current) retryRef.current.stop();
    if (processingRef.current) processingRef.current.stop();
    await serviceManager.stopAll();
    process.exit(0);
  });
}

export interface PersistedSecrets {
  slskdPassword: string;
  lidarrApiKey: string;
  jwtSecret: string;
  soulseekUsername?: string;
  soulseekPassword?: string;
  soulseekListeningPort?: number;
  soulseekEnableUPnP?: boolean;
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
    slskdPassword: generateSecret(16),
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
  const mode = (process.env.NICOTIND_MODE ||
    (fileConfig as Record<string, unknown>).mode ||
    'embedded') as string;
  const isExternalMode = mode === 'external';
  const secrets = loadOrCreateSecrets(dataDir);
  const metadataFixEnabled = parseBooleanEnv(process.env.NICOTIND_METADATA_FIX_ENABLED);

  // Merge: file config < persisted secrets < env vars
  const merged = {
    ...fileConfig,
    port: Number(process.env.NICOTIND_PORT) || (fileConfig as Record<string, unknown>).port,
    dataDir: process.env.NICOTIND_DATA_DIR || (fileConfig as Record<string, unknown>).dataDir,
    musicDir: process.env.NICOTIND_MUSIC_DIR || (fileConfig as Record<string, unknown>).musicDir,
    mode: process.env.NICOTIND_MODE || (fileConfig as Record<string, unknown>).mode,
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
    soulseek: {
      ...((fileConfig as Record<string, unknown>).soulseek as Record<string, unknown>),
      ...(secrets.soulseekUsername ? { username: secrets.soulseekUsername } : {}),
      ...(secrets.soulseekPassword ? { password: secrets.soulseekPassword } : {}),
      ...(secrets.soulseekListeningPort ? { listeningPort: secrets.soulseekListeningPort } : {}),
      ...(secrets.soulseekEnableUPnP !== undefined
        ? { enableUPnP: secrets.soulseekEnableUPnP }
        : {}),
      ...(process.env.SOULSEEK_USERNAME ? { username: process.env.SOULSEEK_USERNAME } : {}),
      ...(process.env.SOULSEEK_PASSWORD ? { password: process.env.SOULSEEK_PASSWORD } : {}),
      ...(process.env.SOULSEEK_LISTENING_PORT
        ? { listeningPort: Number(process.env.SOULSEEK_LISTENING_PORT) }
        : {}),
      ...(process.env.SOULSEEK_ENABLE_UPNP
        ? { enableUPnP: parseBooleanEnv(process.env.SOULSEEK_ENABLE_UPNP) }
        : {}),
    },
    slskd: {
      url: 'http://localhost:5030',
      port: 5030,
      ...((fileConfig as Record<string, unknown>).slskd as Record<string, unknown>),
      username: isExternalMode ? 'slskd' : 'nicotind',
      password: isExternalMode ? 'slskd' : secrets.slskdPassword,
      ...(process.env.NICOTIND_SLSKD_URL ? { url: process.env.NICOTIND_SLSKD_URL } : {}),
      ...(process.env.SLSKD_USERNAME ? { username: process.env.SLSKD_USERNAME } : {}),
      ...(process.env.SLSKD_INTERNAL_USERNAME
        ? { username: process.env.SLSKD_INTERNAL_USERNAME }
        : {}),
      ...(process.env.SLSKD_INTERNAL_PASSWORD
        ? { password: process.env.SLSKD_INTERNAL_PASSWORD }
        : {}),
      ...(process.env.SLSKD_PASSWORD ? { password: process.env.SLSKD_PASSWORD } : {}),
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
