import { parse, stringify } from 'yaml';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceDefinition } from '../strategies/strategy.js';

export function buildSlskdDefinition(config: NicotinDConfig): ServiceDefinition {
  const dataDir = expandPath(config.dataDir);
  const configDir = join(dataDir, 'slskd');
  const musicDir = expandPath(config.musicDir);
  const stagingDir = join(configDir, 'downloads');
  const binDir = join(dataDir, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const configPath = join(configDir, 'slskd.yml');

  // slskd's own remote-config API edits this same file (user-added shares from
  // the extension page live there), so regeneration must merge, not replace:
  // NicotinD owns the managed keys below; everything else is preserved.
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = (parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>) ?? {};
    } catch {
      // Unreadable/corrupt yml: fall back to a clean regenerate.
    }
  }

  const existingShares = (existing.shares as { directories?: string[] } | undefined)
    ?.directories;

  const slskdConfig = {
    ...existing,
    soulseek: {
      username: config.soulseek.username,
      password: config.soulseek.password,
      listening_port: config.soulseek.listeningPort,
      upnp: config.soulseek.enableUPnP,
    },
    directories: {
      // slskd writes here; LibraryOrganizer moves files into musicDir with
      // a clean <Artist>/<Album>/<NN - Title>.<ext> layout.
      downloads: stagingDir,
    },
    shares: {
      // Soulseek etiquette (and many peers) expect sharing — default to the
      // music library so a fresh install shares out of the box; user-added
      // shares (edited via slskd's API into this file) always win.
      directories: existingShares?.length ? existingShares : [musicDir],
    },
    web: {
      authentication: {
        username: config.slskd.username,
        password: config.slskd.password,
      },
    },
  };

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
