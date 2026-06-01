import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceDefinition } from '../strategies/strategy.js';

export function buildNavidromeDefinition(config: NicotinDConfig): ServiceDefinition {
  const dataDir = expandPath(config.dataDir);
  const navidromeDataDir = join(dataDir, 'navidrome');
  mkdirSync(navidromeDataDir, { recursive: true });

  return {
    name: 'navidrome',
    command: join(dataDir, 'bin', 'navidrome'),
    args: [],
    env: {
      ND_MUSICFOLDER: expandPath(config.musicDir),
      ND_DATAFOLDER: navidromeDataDir,
      ND_PORT: String(config.navidrome.port),
      ND_SCANNER_SCHEDULE: '0', // Disabled; NicotinD triggers scans
      // Group albums by artist+name rather than musicbrainz_albumid/releasedate
      // (Navidrome's default). The hunt/fallback flow can place foreign-edition
      // files (deluxe/bonus/acoustic) carrying their own MBID into one
      // <Artist>/<Album> folder; the default PID would then split that folder
      // into a separate card per MBID. Keep dev/prod parity with docker-compose.
      ND_PID_ALBUM: 'albumartistid,album',
    },
    healthCheckUrl: `http://localhost:${config.navidrome.port}/rest/ping.view?u=a&p=a&v=1.16.1&c=healthcheck&f=json`,
    healthCheckTimeoutMs: 30_000,
  };
}

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return join(process.env.HOME ?? '/root', p.slice(1));
  }
  return p;
}
