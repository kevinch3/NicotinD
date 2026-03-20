import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  if (config.mode === 'embedded') {
    log.info('Embedded mode — starting slskd and Navidrome...');
    await serviceManager.startAll();
  }

  // 3. Initialize clients
  const slskd = new Slskd({
    baseUrl: config.slskd.url,
    username: config.slskd.username,
    password: config.slskd.password,
  });

  const navidrome = new Navidrome({
    baseUrl: config.navidrome.url,
    username: config.navidrome.username,
    password: config.navidrome.password,
  });

  // 4. Create and start API server
  const { app, watcher } = createApp({ config, slskd, navidrome, serviceManager });

  watcher.start();

  log.info({ port: config.port }, 'NicotinD is ready');

  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down...');
    watcher.stop();
    await serviceManager.stopAll();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    watcher.stop();
    await serviceManager.stopAll();
    process.exit(0);
  });
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

  // Merge env vars over file config
  const merged = {
    ...fileConfig,
    port: Number(process.env.NICOTIND_PORT) || (fileConfig as Record<string, unknown>).port,
    dataDir: process.env.NICOTIND_DATA_DIR || (fileConfig as Record<string, unknown>).dataDir,
    musicDir: process.env.NICOTIND_MUSIC_DIR || (fileConfig as Record<string, unknown>).musicDir,
    mode: process.env.NICOTIND_MODE || (fileConfig as Record<string, unknown>).mode,
    soulseek: {
      username: process.env.SOULSEEK_USERNAME || '',
      password: process.env.SOULSEEK_PASSWORD || '',
      ...((fileConfig as Record<string, unknown>).soulseek as Record<string, unknown>),
    },
    slskd: {
      url: process.env.NICOTIND_SLSKD_URL || 'http://localhost:5030',
      port: 5030,
      username: 'nicotind',
      password: process.env.SLSKD_INTERNAL_PASSWORD || generateSecret(16),
      ...((fileConfig as Record<string, unknown>).slskd as Record<string, unknown>),
    },
    navidrome: {
      url: process.env.NICOTIND_NAVIDROME_URL || 'http://localhost:4533',
      port: 4533,
      username: 'nicotind',
      password: process.env.NAVIDROME_INTERNAL_PASSWORD || generateSecret(16),
      ...((fileConfig as Record<string, unknown>).navidrome as Record<string, unknown>),
    },
    jwt: {
      secret: process.env.NICOTIND_JWT_SECRET || generateSecret(32),
      expiresIn: '24h',
      ...((fileConfig as Record<string, unknown>).jwt as Record<string, unknown>),
    },
  };

  return NicotinDConfigSchema.parse(merged);
}

main().catch((err) => {
  log.fatal({ err }, 'Failed to start NicotinD');
  process.exit(1);
});
