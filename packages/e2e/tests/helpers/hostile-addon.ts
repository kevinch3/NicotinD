import { createServer, type Server } from 'node:http';

export const HOSTILE_ADDON_TOKEN = 'hostile-token';

export interface HostileAddon {
  url: string;
  close(): Promise<void>;
}

/**
 * A deliberately-malicious addon (§4 adversarial fixture): serves whatever
 * manifest the spec hands it, plus a healthy `/health`, so core's registration
 * defenses (manifest validation, version-range, capability negotiation) can be
 * proven to reject it while the server stays up. Kept separate from the
 * well-behaved fixture-addon so the happy-path specs are untouched.
 */
export async function startHostileAddon(manifest: unknown): Promise<HostileAddon> {
  const server: Server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/addon/v1/manifest') return json(200, manifest);
    if (path === '/addon/v1/health') return json(200, { ok: true, ready: true });
    return json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
