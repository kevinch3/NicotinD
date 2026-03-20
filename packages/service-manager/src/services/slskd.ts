import { stringify } from 'yaml';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceDefinition } from '../strategies/strategy.js';

export function buildSlskdDefinition(config: NicotinDConfig): ServiceDefinition {
  const dataDir = expandPath(config.dataDir);
  const configDir = join(dataDir, 'slskd');
  const musicDir = expandPath(config.musicDir);
  const binDir = join(dataDir, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(musicDir, { recursive: true });

  const slskdConfig = {
    soulseek: {
      username: config.soulseek.username,
      password: config.soulseek.password,
    },
    directories: {
      downloads: musicDir,
    },
    web: {
      authentication: {
        username: config.slskd.username,
        password: config.slskd.password,
      },
    },
  };

  const configPath = join(configDir, 'slskd.yml');
  writeFileSync(configPath, stringify(slskdConfig), 'utf-8');

  return {
    name: 'slskd',
    command: join(dataDir, 'bin', 'slskd'),
    args: ['--config', configPath, '--http-port', String(config.slskd.port)],
    cwd: binDir,
    env: {
      SLSKD_APP_DIR: configDir,
    },
    healthCheckUrl: `http://localhost:${config.slskd.port}/api/v0/session/enabled`,
    healthCheckTimeoutMs: 30_000,
  };
}

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return join(process.env.HOME ?? '/root', p.slice(1));
  }
  return p;
}
