import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ADDON_TOKEN = 'fixture-token';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A committed silent FLAC tagged "Addon Artist / Addon Album / Addon Song" —
 *  lives OUTSIDE fixtures/music so the boot scan never indexes it; it enters
 *  the library only through the addon ingest loop under test. */
const ADDON_FLAC = join(HERE, '../../fixtures/addon/addon-song.flac');

/** What the fixture addon delivers + advertises. Parameterized so a hunt test
 *  can download a specific named album (e.g. Rick Astley) end-to-end; the tags
 *  in `flacPath` are what actually land in the library (the scanner reads tags,
 *  not the wire filename). */
export interface FixturePayload {
  flacPath: string;
  artist: string;
  album: string;
  title: string;
  /** slskd-style backslash path the addon reports for the file. */
  filename: string;
}

const DEFAULT_PAYLOAD: FixturePayload = {
  flacPath: ADDON_FLAC,
  artist: 'Addon Artist',
  album: 'Addon Album',
  title: 'Addon Song',
  filename: 'Music\\Addon Album\\Addon Song.flac',
};

/** A committed silent FLAC tagged as the canonical rickroll — for the hunt→
 *  download e2e that acquires "Rick Astley — Whenever You Need Somebody". */
export const RICK_ASTLEY_PAYLOAD: FixturePayload = {
  flacPath: join(HERE, '../../fixtures/addon/rick-astley.flac'),
  artist: 'Rick Astley',
  album: 'Whenever You Need Somebody',
  title: 'Never Gonna Give You Up',
  filename: 'Music\\Rick Astley\\Whenever You Need Somebody\\01 Never Gonna Give You Up.flac',
};

interface FixtureJobItem {
  itemId: string;
  title: string | null;
  username: string;
  filename: string;
  size: number;
  bitRateKbps?: number;
  audioFormat?: string;
  state: string;
  fileReady: boolean;
  updatedAt: number;
}

interface FixtureJob {
  id: string;
  intent: string;
  artist: string | null;
  album: string | null;
  state: string;
  error: string | null;
  items: FixtureJobItem[];
  createdAt: number;
  updatedAt: number;
}

export interface FixtureAddon {
  url: string;
  /** Bodies received on PUT /addon/v1/config, newest last. */
  configPushes: unknown[];
  /** Flip every job to completed + fileReady (the "download finished" hook). */
  completeJobs(): void;
  /** Make `/albums/search` report the search was throttled (429) — an empty +
   *  rate-limited result, so the UI shows "keep trying" not "no results". */
  setRateLimited(v: boolean): void;
  jobs: FixtureJob[];
  close(): Promise<void>;
}

/**
 * A minimal in-process acquisition addon (protocol v1) for e2e specs: manifest,
 * health, bearer-guarded status + config. Runs on an ephemeral port in the
 * Playwright worker; the NicotinD server reaches it over 127.0.0.1.
 */
export interface FixtureAddonOptions {
  /** Manifest id (default `fixture-addon`) — set unique to run alongside another. */
  id?: string;
  /** Manifest capabilities (default: the search/browse/download set). */
  capabilities?: string[];
  /** URL patterns for a resolve addon (so `resolveAddonForUrl` routes to it). */
  urlPatterns?: string[];
  /** What the addon delivers + advertises (default: the "Addon Artist" song). */
  payload?: FixturePayload;
}

export async function startFixtureAddon(opts: FixtureAddonOptions = {}): Promise<FixtureAddon> {
  const id = opts.id ?? 'fixture-addon';
  const capabilities = opts.capabilities ?? ['search', 'browse', 'download'];
  const payload = opts.payload ?? DEFAULT_PAYLOAD;
  const payloadBytes = readFileSync(payload.flacPath);
  const payloadSize = payloadBytes.length;
  const configPushes: unknown[] = [];
  const jobs: FixtureJob[] = [];
  let nextJob = 1;
  let rateLimited = false;

  const server: Server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (body: unknown) => void) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        try {
          cb(JSON.parse(raw));
        } catch {
          cb(null);
        }
      });
    };
    const authorized = req.headers.authorization === `Bearer ${FIXTURE_ADDON_TOKEN}`;

    if (path === '/addon/v1/manifest') {
      return json(200, {
        id,
        name: 'Fixture Addon',
        description: 'An e2e test acquisition addon.',
        version: '0.1.0',
        protocolVersion: '1.0.0',
        kind: 'acquisition',
        capabilities,
        ...(opts.urlPatterns ? { urlPatterns: opts.urlPatterns } : {}),
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
      return readBody((body) => {
        configPushes.push(body);
        res.writeHead(204).end();
      });
    }

    // ——— Engine surface (phase 2) ———
    if (!authorized && path.startsWith('/addon/v1/')) return json(401, { error: 'unauthorized' });

    if (path === '/addon/v1/search' && req.method === 'POST') {
      return readBody(() =>
        json(200, {
          results: [
            {
              kind: 'song',
              title: 'Addon Song.flac',
              username: 'fixture-peer',
              directory: 'Music/Addon Album',
              filename: 'Music\\Addon Album\\Addon Song.flac',
              size: 12604,
              bitRateKbps: 900,
              freeUploadSlots: 1,
              queueLength: 0,
              uploadSpeed: 100000,
            },
          ],
          complete: true,
        }),
      );
    }

    // Album hunt (protocol albums/search): scored folder candidates, or — when
    // rate-limited — an empty result flagged `rateLimited` so the host UI shows
    // "keep trying" rather than "no results" (#hunt-429).
    if (path === '/addon/v1/albums/search' && req.method === 'POST') {
      return readBody(() => {
        if (rateLimited)
          return json(200, { candidates: [], queries: [], skewNeeded: false, rateLimited: true });
        json(200, {
          candidates: [
            {
              candidateRef: 'fixture-candidate-1',
              username: 'fixture-peer',
              directory: payload.filename.split('\\').slice(0, -1).join('\\'),
              matchPct: 100,
              matchedTracks: 1,
              totalTracks: 1,
              format: 'FLAC',
              estimatedSizeMb: 1,
              isLive: false,
              freeUploadSlots: 1,
              queueLength: 0,
              uploadSpeed: 100000,
              files: [{ filename: payload.filename, size: payloadSize, bitRateKbps: 900 }],
            },
          ],
          queries: [`${payload.artist} ${payload.album}`],
          skewNeeded: false,
        });
      });
    }

    if (path === '/addon/v1/jobs' && req.method === 'POST') {
      return readBody((body) => {
        const b = (body ?? {}) as { intent?: string; artist?: string; album?: string };
        const now = Date.now();
        const job: FixtureJob = {
          id: `fixture-job-${nextJob++}`,
          intent: b.intent ?? 'browse-grab',
          artist: b.artist ?? payload.artist,
          album: b.album ?? payload.album,
          state: 'active',
          error: null,
          createdAt: now,
          updatedAt: now,
          items: [
            {
              itemId: `t:${payload.title.toLowerCase()}`,
              title: payload.title,
              username: 'fixture-peer',
              filename: payload.filename,
              size: payloadSize,
              bitRateKbps: 900,
              audioFormat: 'FLAC',
              state: 'downloading',
              fileReady: false,
              updatedAt: now,
            },
          ],
        };
        jobs.push(job);
        json(201, { job });
      });
    }

    if (path === '/addon/v1/jobs' && req.method === 'GET') {
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('since') ?? '') || 0;
      return json(200, { jobs: jobs.filter((j) => j.updatedAt > since) });
    }

    const fileMatch = path.match(/^\/addon\/v1\/jobs\/([^/]+)\/files\/(.+)$/);
    if (fileMatch && req.method === 'GET') {
      const job = jobs.find((j) => j.id === fileMatch[1]);
      const item = job?.items.find((i) => i.itemId === decodeURIComponent(fileMatch[2]!));
      if (!job || !item) return json(404, { error: 'not found' });
      if (!item.fileReady) return json(409, { error: 'not ready' });
      const bytes = payloadBytes;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        ETag: '"fixture"',
      });
      return res.end(bytes);
    }

    const jobMatch = path.match(/^\/addon\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'DELETE') {
      const idx = jobs.findIndex((j) => j.id === jobMatch[1]);
      if (idx >= 0) jobs.splice(idx, 1);
      return json(200, { ok: true });
    }
    if (jobMatch && req.method === 'GET') {
      const job = jobs.find((j) => j.id === jobMatch[1]);
      return job ? json(200, { job }) : json(404, { error: 'not found' });
    }

    return json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    configPushes,
    jobs,
    completeJobs() {
      const now = Date.now();
      for (const job of jobs) {
        job.state = 'done';
        job.updatedAt = now;
        for (const item of job.items) {
          item.state = 'completed';
          item.fileReady = true;
          item.updatedAt = now;
        }
      }
    },
    setRateLimited(v: boolean) {
      rateLimited = v;
    },
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
