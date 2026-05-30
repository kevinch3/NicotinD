import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { NicotinDConfigSchema, createLogger, generateSecret } from '@nicotind/core';
import { ServiceManager, NativeProcessStrategy } from '@nicotind/service-manager';
import { Slskd } from '@nicotind/slskd-client';
import { Navidrome } from '@nicotind/navidrome-client';
import { Lidarr } from '@nicotind/lidarr-client';
import { createApp, TailscaleService } from '@nicotind/api';

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
    const navidromeBin = join(binDir, 'navidrome');
    const slskdBin = join(binDir, 'slskd');
    const lidarrBin = join(binDir, 'Lidarr', 'Lidarr');

    // Only require slskd binary if Soulseek credentials are configured
    const needsSlskd = hasSoulseekCreds && !existsSync(slskdBin);
    const needsNavidrome = !existsSync(navidromeBin);
    // Lidarr is optional; its download is best-effort inside download-deps.
    const needsLidarr = !!config.lidarr && !existsSync(lidarrBin);

    if (needsSlskd || needsNavidrome || needsLidarr) {
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
    await serviceManager.startNavidrome();
    // Only start Lidarr if its binary is actually present — avoids a slow,
    // doomed health-check wait when the (best-effort) download didn't land.
    if (config.lidarr && existsSync(lidarrBin)) {
      await serviceManager.startLidarr(startupSecrets.lidarrApiKey);
    } else if (config.lidarr) {
      log.info('Lidarr binary not present — discography features disabled (embedded)');
    }

    // Auto-create Navidrome admin user on first run
    await createNavidromeAdmin(config, config.dataDir, startupSecrets);
  }

  // Auto-create Navidrome admin user in external mode too
  if (config.mode === 'external') {
    await createNavidromeAdmin(config, config.dataDir, startupSecrets);
  }

  // 3. Initialize clients (slskd wrapped in mutable ref for hot-swap via settings)
  const slskdRef: { current: Slskd | null } = {
    current: new Slskd({
      baseUrl: config.slskd.url,
      username: config.slskd.username,
      password: config.slskd.password,
    }),
  };

  const navidrome = new Navidrome({
    baseUrl: config.navidrome.url,
    username: config.navidrome.username,
    password: config.navidrome.password,
  });

  const lidarr = config.lidarr
    ? new Lidarr({ baseUrl: config.lidarr.url, apiKey: config.lidarr.apiKey })
    : null;

  // 4. Create and start API server
  const webDistPath = resolve(import.meta.dir, '../packages/web/dist');

  // Reuse startup secrets (already loaded above) for Tailscale auto-reconnect
  const secrets = startupSecrets;

  // Auto-reconnect Tailscale on startup if an auth key was previously saved
  const tailscale = new TailscaleService();
  const tsStatus = await tailscale.getStatus();
  if (tsStatus.available && !tsStatus.connected && secrets.tailscale?.authKey) {
    log.info('Tailscale not connected — attempting auto-reconnect with stored key');
    await tailscale.connect(secrets.tailscale.authKey).catch((err) => {
      log.warn({ err }, 'Tailscale auto-reconnect failed');
    });
  }

  const { app, watcherRef, websocket } = createApp({
    config,
    slskdRef,
    navidrome,
    lidarr,
    serviceManager,
    webDistPath,
    saveSecretsFn: (username: string, password: string) => {
      const currentSecrets = loadOrCreateSecrets(config.dataDir);
      currentSecrets.soulseekUsername = username;
      currentSecrets.soulseekPassword = password;
      saveSecrets(config.dataDir, currentSecrets);
    },
    tailscale,
    saveTailscaleAuthKeyFn: (key: string) => {
      const current = loadOrCreateSecrets(config.dataDir);
      current.tailscale = { authKey: key };
      saveSecrets(config.dataDir, current);
    },
    clearTailscaleAuthKeyFn: () => {
      const current = loadOrCreateSecrets(config.dataDir);
      delete current.tailscale;
      saveSecrets(config.dataDir, current);
    },
    stagingDir: join(
      config.dataDir.startsWith('~') ? join(process.env.HOME ?? '/root', config.dataDir.slice(1)) : config.dataDir,
      'slskd',
      'downloads',
    ),
    acoustidApiKey: secrets.acoustidApiKey,
  });

  if (watcherRef.current) watcherRef.current.start();

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
    await serviceManager.stopAll();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    if (watcherRef.current) watcherRef.current.stop();
    await serviceManager.stopAll();
    process.exit(0);
  });
}

export interface PersistedSecrets {
  slskdPassword: string;
  navidromePassword: string;
  lidarrApiKey: string;
  jwtSecret: string;
  soulseekUsername?: string;
  soulseekPassword?: string;
  soulseekListeningPort?: number;
  soulseekEnableUPnP?: boolean;
  tailscale?: { authKey: string };
  navidromeAdminCreated?: boolean;
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
    navidromePassword: generateSecret(16),
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

async function createNavidromeAdmin(
  config: { navidrome: { url: string; username: string; password: string } },
  dataDir: string,
  secrets: PersistedSecrets,
) {
  if (secrets.navidromeAdminCreated) return;
  try {
    const res = await fetch(`${config.navidrome.url}/auth/createAdmin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: config.navidrome.username,
        password: config.navidrome.password,
      }),
    });
    if (res.ok) {
      log.info('Created Navidrome admin user');
      secrets.navidromeAdminCreated = true;
      saveSecrets(dataDir, secrets);
    } else if (res.status === 403) {
      // Admin already exists — mark as done so we skip on future restarts
      secrets.navidromeAdminCreated = true;
      saveSecrets(dataDir, secrets);
    }
  } catch {
    // Navidrome not reachable yet — will retry next restart if flag not set
  }
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
    soulseek: {
      ...((fileConfig as Record<string, unknown>).soulseek as Record<string, unknown>),
      ...(secrets.soulseekUsername ? { username: secrets.soulseekUsername } : {}),
      ...(secrets.soulseekPassword ? { password: secrets.soulseekPassword } : {}),
      ...(secrets.soulseekListeningPort ? { listeningPort: secrets.soulseekListeningPort } : {}),
      ...(secrets.soulseekEnableUPnP !== undefined ? { enableUPnP: secrets.soulseekEnableUPnP } : {}),
      ...(process.env.SOULSEEK_USERNAME ? { username: process.env.SOULSEEK_USERNAME } : {}),
      ...(process.env.SOULSEEK_PASSWORD ? { password: process.env.SOULSEEK_PASSWORD } : {}),
      ...(process.env.SOULSEEK_LISTENING_PORT ? { listeningPort: Number(process.env.SOULSEEK_LISTENING_PORT) } : {}),
      ...(process.env.SOULSEEK_ENABLE_UPNP ? { enableUPnP: parseBooleanEnv(process.env.SOULSEEK_ENABLE_UPNP) } : {}),
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
    navidrome: {
      url: 'http://localhost:4533',
      port: 4533,
      username: 'nicotind',
      password: secrets.navidromePassword,
      ...((fileConfig as Record<string, unknown>).navidrome as Record<string, unknown>),
      ...(process.env.NICOTIND_NAVIDROME_URL ? { url: process.env.NICOTIND_NAVIDROME_URL } : {}),
      ...(process.env.NAVIDROME_INTERNAL_PASSWORD
        ? { password: process.env.NAVIDROME_INTERNAL_PASSWORD }
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
      expiresIn: '24h',
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
