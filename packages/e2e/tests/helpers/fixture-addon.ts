import { createServer, type Server } from 'node:http';

export const FIXTURE_ADDON_TOKEN = 'fixture-token';

export interface FixtureAddon {
  url: string;
  /** Bodies received on PUT /addon/v1/config, newest last. */
  configPushes: unknown[];
  close(): Promise<void>;
}

/**
 * A minimal in-process acquisition addon (protocol v1) for e2e specs: manifest,
 * health, bearer-guarded status + config. Runs on an ephemeral port in the
 * Playwright worker; the NicotinD server reaches it over 127.0.0.1.
 */
export async function startFixtureAddon(): Promise<FixtureAddon> {
  const configPushes: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authorized = req.headers.authorization === `Bearer ${FIXTURE_ADDON_TOKEN}`;

    if (path === '/addon/v1/manifest') {
      return json(200, {
        id: 'fixture-addon',
        name: 'Fixture Addon',
        description: 'An e2e test acquisition addon.',
        version: '0.1.0',
        protocolVersion: '1.0.0',
        kind: 'acquisition',
        capabilities: ['search'],
        configFields: [{ key: 'username', label: 'Username', type: 'text' }],
        statusFields: [{ key: 'peers', label: 'Peers' }],
        compliance: { disclaimer: 'Fixture addon for tests.', requiresConsent: true },
      });
    }
    if (path === '/addon/v1/health') return json(200, { ok: true, ready: true });
    if (path === '/addon/v1/status') {
      if (!authorized) return json(401, { error: 'unauthorized' });
      return json(200, [{ key: 'peers', label: 'Peers', value: '42' }]);
    }
    if (path === '/addon/v1/config' && req.method === 'PUT') {
      if (!authorized) return json(401, { error: 'unauthorized' });
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        try {
          configPushes.push(JSON.parse(body));
        } catch {
          configPushes.push(body);
        }
        res.writeHead(204).end();
      });
      return;
    }
    return json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    configPushes,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
