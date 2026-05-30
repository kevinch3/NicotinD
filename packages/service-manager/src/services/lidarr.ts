import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceDefinition } from '../strategies/strategy.js';

export function buildLidarrDefinition(config: NicotinDConfig, apiKey: string): ServiceDefinition {
  const dataDir = expandPath(config.dataDir);
  const lidarrDataDir = join(dataDir, 'lidarr');
  mkdirSync(lidarrDataDir, { recursive: true });

  // Pre-write config.xml so Lidarr starts with our generated API key
  const port = config.lidarr?.port ?? 8686;
  const configXml = `<Config>
  <ApiKey>${apiKey}</ApiKey>
  <AuthenticationMethod>None</AuthenticationMethod>
  <Port>${port}</Port>
  <BindAddress>*</BindAddress>
  <SslPort>6969</SslPort>
  <EnableSsl>False</EnableSsl>
  <LaunchBrowser>False</LaunchBrowser>
  <Branch>master</Branch>
  <LogLevel>Info</LogLevel>
  <UpdateMechanism>BuiltIn</UpdateMechanism>
</Config>`;
  writeFileSync(join(lidarrDataDir, 'config.xml'), configXml, 'utf-8');

  return {
    name: 'lidarr',
    // Lidarr's archive extracts to bin/Lidarr/ containing the executable.
    command: join(dataDir, 'bin', 'Lidarr', 'Lidarr'),
    args: ['-nobrowser', '-data', lidarrDataDir],
    env: {},
    healthCheckUrl: `http://localhost:${port}/ping`,
    healthCheckTimeoutMs: 60_000,
  };
}

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return join(process.env.HOME ?? '/root', p.slice(1));
  }
  return p;
}
