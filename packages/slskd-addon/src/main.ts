import { Slskd } from '@nicotind/slskd-client';
import { createLogger } from '@nicotind/core';
import { getDatabase } from './db.js';
import { resolveConfig } from './config.js';
import { createAddonApp } from './server.js';

const log = createLogger('slskd-addon');

const db = getDatabase();
let config = resolveConfig(db);

if (!config.token) {
  log.error('SLSKD_ADDON_TOKEN is not set — refusing to start without an access token');
  process.exit(1);
}

const slskdRef = {
  current: new Slskd({
    baseUrl: config.slskdUrl,
    username: config.slskdUsername,
    password: config.slskdPassword,
  }),
};

const app = createAddonApp({
  db,
  slskdRef,
  token: config.token,
  onConfigChanged: () => {
    config = resolveConfig(db);
    slskdRef.current = new Slskd({
      baseUrl: config.slskdUrl,
      username: config.slskdUsername,
      password: config.slskdPassword,
    });
    log.info('config updated — slskd client rebuilt');
  },
});

const port = Number(process.env.SLSKD_ADDON_PORT ?? 8585);
Bun.serve({ port, fetch: app.fetch });
log.info({ port }, 'slskd addon listening');
