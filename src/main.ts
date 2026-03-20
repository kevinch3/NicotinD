import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { NicotinDConfigSchema, createLogger, generateSecret } from '@nicotind/core';
import { ServiceManager, NativeProcessStrategy } from '@nicotind/service-manager';
import { Slskd } from '@nicotind/slskd-client';
import { Navidrome } from '@nicotind/navidrome-client';
import { createApp } from '@nicotind/api';

const log = createLogger('nicotind');

async function main() {
  log.info('Starting NicotinD...');

  // 1. Load configuration
  const config = loadConfig();
  log.info({ port: config.port, mode: config.mode, musicDir: config.musicDir }, 'Configuration loaded');

  // 2. Start sub-services (if embedded mode)
  const strategy = new NativeProcessStrategy();
  const serviceManager = new ServiceManager(strategy, config);

  const hasSoulseekCreds = !!(config.soulseek.username && config.soulseek.password);

  if (config.mode === 'embedded') {
    // Auto-download binaries if missing
    const dataDir = config.dataDir.startsWith('~')
      ? join(process.env.HOME ?? '/root', config.dataDir.slice(1))
      : config.dataDir;
    const binDir = join(dataDir, 'bin');
    const navidromeBin = join(binDir, 'navidrome');
    const slskdBin = join(binDir, 'slskd');

    // Only require slskd binary if Soulseek credentials are configured
    const needsSlskd = hasSoulseekCreds && !existsSync(slskdBin);
    const needsNavidrome = !existsSync(navidromeBin);

    if (needsSlskd || needsNavidrome) {
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

    // Auto-create Navidrome admin user on first run
    const ndUrl = config.navidrome.url;
    try {
      const createAdminRes = await fetch(`${ndUrl}/auth/createAdmin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: config.navidrome.username,
          password: config.navidrome.password,
        }),
      });
      if (createAdminRes.ok) {
        log.info('Created Navidrome admin user');
      }
    } catch {
      // Already created or Navidrome doesn't support this — fine
    }
  }

  // 3. Initialize clients (slskd wrapped in mutable ref for hot-swap via settings)
  const slskdRef: { current: Slskd | null } = {
    current: hasSoulseekCreds
      ? new Slskd({
          baseUrl: config.slskd.url,
          username: config.slskd.username,
          password: config.slskd.password,
        })
      : null,
  };

  const navidrome = new Navidrome({
    baseUrl: config.navidrome.url,
    username: config.navidrome.username,
    password: config.navidrome.password,
  });

  // 4. Create and start API server
  const webDistPath = resolve(import.meta.dir, '../packages/web/dist');
  const { app, watcherRef } = createApp({ config, slskdRef, navidrome, serviceManager, webDistPath });

  if (watcherRef.current) watcherRef.current.start();

  log.info({ port: config.port }, 'NicotinD is ready');

  Bun.serve({
    port: config.port,
    fetch: app.fetch,
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
  jwtSecret: string;
  soulseekUsername?: string;
  soulseekPassword?: string;
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

  const dataDir = process.env.NICOTIND_DATA_DIR
    || (fileConfig as Record<string, unknown>).dataDir as string
    || '~/.nicotind';
  const secrets = loadOrCreateSecrets(dataDir);

  // Merge: file config < persisted secrets < env vars
  const merged = {
    ...fileConfig,
    port: Number(process.env.NICOTIND_PORT) || (fileConfig as Record<string, unknown>).port,
    dataDir: process.env.NICOTIND_DATA_DIR || (fileConfig as Record<string, unknown>).dataDir,
    musicDir: process.env.NICOTIND_MUSIC_DIR || (fileConfig as Record<string, unknown>).musicDir,
    mode: process.env.NICOTIND_MODE || (fileConfig as Record<string, unknown>).mode,
    soulseek: {
      ...((fileConfig as Record<string, unknown>).soulseek as Record<string, unknown>),
      ...(secrets.soulseekUsername ? { username: secrets.soulseekUsername } : {}),
      ...(secrets.soulseekPassword ? { password: secrets.soulseekPassword } : {}),
      ...(process.env.SOULSEEK_USERNAME ? { username: process.env.SOULSEEK_USERNAME } : {}),
      ...(process.env.SOULSEEK_PASSWORD ? { password: process.env.SOULSEEK_PASSWORD } : {}),
    },
    slskd: {
      url: 'http://localhost:5030',
      port: 5030,
      username: 'nicotind',
      password: secrets.slskdPassword,
      ...((fileConfig as Record<string, unknown>).slskd as Record<string, unknown>),
      ...(process.env.NICOTIND_SLSKD_URL ? { url: process.env.NICOTIND_SLSKD_URL } : {}),
      ...(process.env.SLSKD_INTERNAL_PASSWORD ? { password: process.env.SLSKD_INTERNAL_PASSWORD } : {}),
    },
    navidrome: {
      url: 'http://localhost:4533',
      port: 4533,
      username: 'nicotind',
      password: secrets.navidromePassword,
      ...((fileConfig as Record<string, unknown>).navidrome as Record<string, unknown>),
      ...(process.env.NICOTIND_NAVIDROME_URL ? { url: process.env.NICOTIND_NAVIDROME_URL } : {}),
      ...(process.env.NAVIDROME_INTERNAL_PASSWORD ? { password: process.env.NAVIDROME_INTERNAL_PASSWORD } : {}),
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
