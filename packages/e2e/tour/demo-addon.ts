/**
 * The demo acquisition addon (protocol v1): a source whose whole catalog is the
 * `acquirable` pool of the demo catalog, delivered as the generated FLAC files.
 *
 * Grown out of `tests/helpers/fixture-addon.ts`, with the two things a viewer
 * sees and a spec does not need: a multi-track album delivered item by item,
 * and downloads that progress on their own clock (a spec flips them with
 * `completeJobs()`; a tour cannot reach into the addon mid-shot). A real addon
 * process, registered over HTTP like any other — nothing core-side knows it is
 * a demo.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_ALBUMS, demoSlug, demoTracks, type DemoAlbum } from '../../core/src/demo/index.js';
import { albumDir, trackFileName } from './make-demo-library.js';

export const DEMO_ADDON_ID = 'demo-source';
export const DEMO_ADDON_TOKEN = 'demo-token';

/** How long one track takes to "download", and the stagger between tracks. */
const TRACK_MS = 2_400;
const STAGGER_MS = 700;
const TICK_MS = 300;

/**
 * Two sources per album, so the hunt's "choose a different source" list has a
 * real alternative. The best one leads, as the host's ranking would put it.
 */
const PEERS = [
  { username: 'harbor-records', format: 'FLAC', bitRateKbps: 900, matchPct: 100, speed: 2_400_000 },
  { username: 'nightowl-archive', format: 'FLAC', bitRateKbps: 880, matchPct: 83, speed: 600_000 },
] as const;

interface Item {
  itemId: string;
  title: string;
  username: string;
  filename: string;
  size: number;
  bitRateKbps: number;
  audioFormat: string;
  state: 'queued' | 'downloading' | 'completed';
  fileReady: boolean;
  bytesTransferred: number;
  updatedAt: number;
  /** Local file delivered for this item — never sent over the wire. */
  path: string;
  startsAt: number;
}

interface Job {
  id: string;
  intent: string;
  artist: string | null;
  album: string | null;
  state: 'active' | 'done' | 'cancelled';
  error: string | null;
  items: Item[];
  createdAt: number;
  updatedAt: number;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const POOL = DEMO_ALBUMS.filter((a) => a.pool === 'acquirable');

function poolFiles(album: DemoAlbum) {
  return demoTracks(album).map((t) => {
    const path = join(albumDir(album), trackFileName(t));
    return {
      title: t.title,
      path,
      size: statSync(path).size,
      filename: `Music\\${album.artist}\\${album.title}\\${trackFileName(t)}`,
    };
  });
}

const candidateRef = (album: DemoAlbum, peer: number) =>
  `${demoSlug(album.artist)}/${demoSlug(album.title)}#${peer}`;

export async function startDemoAddon(port: number): Promise<Server> {
  const jobs: Job[] = [];
  let nextJob = 1;

  // Advance every active job on its own clock. `updatedAt` moves only on a real
  // change, so the host's `?since=` cursor sees each step exactly once.
  setInterval(() => {
    const now = Date.now();
    for (const job of jobs) {
      if (job.state !== 'active') continue;
      for (const item of job.items) {
        if (item.state === 'completed' || now < item.startsAt) continue;
        const fraction = Math.min(1, (now - item.startsAt) / TRACK_MS);
        item.state = fraction >= 1 ? 'completed' : 'downloading';
        item.fileReady = fraction >= 1;
        item.bytesTransferred = Math.round(item.size * fraction);
        item.updatedAt = now;
        job.updatedAt = now;
      }
      if (job.items.every((i) => i.state === 'completed')) {
        job.state = 'done';
        job.updatedAt = now;
      }
    }
  }, TICK_MS).unref();

  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (body: Record<string, unknown>) => void) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        try {
          cb((JSON.parse(raw) ?? {}) as Record<string, unknown>);
        } catch {
          cb({});
        }
      });
    };
    const wire = (job: Job) => ({
      ...job,
      items: job.items.map(({ path: _path, startsAt: _startsAt, ...item }) => item),
    });

    if (path === '/addon/v1/manifest') {
      return json(200, {
        id: DEMO_ADDON_ID,
        name: 'Demo Source',
        description: 'The NicotinD demo catalog: generated recordings, free to share.',
        version: '0.1.0',
        protocolVersion: '1.0.0',
        kind: 'acquisition',
        capabilities: ['search', 'browse', 'download'],
        configFields: [],
        statusFields: [{ key: 'catalog', label: 'Catalog' }],
        compliance: { disclaimer: 'Serves generated demo audio only.', requiresConsent: false },
      });
    }
    if (path === '/addon/v1/health') return json(200, { ok: true, ready: true });
    if (req.headers.authorization !== `Bearer ${DEMO_ADDON_TOKEN}`) {
      return json(401, { error: 'unauthorized' });
    }
    if (path === '/addon/v1/status') {
      return json(200, [{ key: 'catalog', label: 'Catalog', value: `${POOL.length} albums` }]);
    }
    if (path === '/addon/v1/config' && req.method === 'PUT') {
      return readBody(() => res.writeHead(204).end());
    }

    if (path === '/addon/v1/search' && req.method === 'POST') {
      return readBody((body) => {
        const tokens = fold(String(body.query ?? ''))
          .split(/\s+/)
          .filter(Boolean);
        const results = POOL.flatMap((album) =>
          poolFiles(album)
            .filter((f) =>
              tokens.every((t) => fold(`${album.artist} ${album.title} ${f.title}`).includes(t)),
            )
            .map((f) => ({
              kind: 'song',
              title: f.filename.split('\\').at(-1),
              username: PEERS[0].username,
              directory: f.filename.split('\\').slice(0, -1).join('\\'),
              filename: f.filename,
              size: f.size,
              bitRateKbps: PEERS[0].bitRateKbps,
              audioFormat: 'FLAC',
              freeUploadSlots: 3,
              queueLength: 0,
              uploadSpeed: PEERS[0].speed,
            })),
        );
        json(200, { results, complete: true });
      });
    }

    if (path === '/addon/v1/albums/search' && req.method === 'POST') {
      return readBody((body) => {
        const album = POOL.find(
          (a) =>
            fold(a.title) === fold(String(body.album ?? '')) &&
            fold(a.artist) === fold(String(body.artist ?? '')),
        );
        const queries = [`${body.artist ?? ''} ${body.album ?? ''}`.trim()];
        if (!album) return json(200, { candidates: [], queries, skewNeeded: false });
        const files = poolFiles(album);
        const totalMb = files.reduce((n, f) => n + f.size, 0) / 1_000_000;
        json(200, {
          candidates: PEERS.map((peer, i) => {
            const matched = Math.round((files.length * peer.matchPct) / 100);
            return {
              candidateRef: candidateRef(album, i),
              username: peer.username,
              directory: `Music\\${album.artist}\\${album.title}`,
              matchPct: peer.matchPct,
              matchedTracks: matched,
              totalTracks: files.length,
              format: peer.format,
              estimatedSizeMb: Math.max(1, Math.round((totalMb * matched) / files.length)),
              isLive: false,
              freeUploadSlots: i === 0 ? 3 : 1,
              queueLength: i === 0 ? 0 : 4,
              uploadSpeed: peer.speed,
              files: files.slice(0, matched).map((f) => ({
                filename: f.filename,
                size: f.size,
                bitRateKbps: peer.bitRateKbps,
              })),
            };
          }),
          queries,
          skewNeeded: false,
          searchesFired: 1,
          searchesAnswered: 1,
        });
      });
    }

    if (path === '/addon/v1/jobs' && req.method === 'POST') {
      return readBody((body) => {
        const ref = String(body.candidateRef ?? '');
        const [albumKey, peerIdx] = ref.split('#');
        const album =
          POOL.find((a) => `${demoSlug(a.artist)}/${demoSlug(a.title)}` === albumKey) ??
          POOL.find((a) => fold(a.title) === fold(String(body.album ?? '')));
        if (!album) return json(400, { error: 'demo source: unknown album' });
        const peer = PEERS[Number(peerIdx) || 0] ?? PEERS[0];
        const wanted = Array.isArray(body.wantedTracks)
          ? new Set((body.wantedTracks as Array<{ title: string }>).map((t) => fold(t.title)))
          : null;
        const now = Date.now();
        const items: Item[] = poolFiles(album)
          .filter((f) => !wanted || wanted.has(fold(f.title)))
          .map((f, i) => ({
            itemId: `${demoSlug(album.title)}:${demoSlug(f.title)}`,
            title: f.title,
            username: peer.username,
            filename: f.filename,
            size: f.size,
            bitRateKbps: peer.bitRateKbps,
            audioFormat: 'FLAC',
            state: 'queued',
            fileReady: false,
            bytesTransferred: 0,
            updatedAt: now,
            path: f.path,
            startsAt: now + i * STAGGER_MS,
          }));
        const job: Job = {
          id: `demo-job-${nextJob++}`,
          intent: String(body.intent ?? 'album'),
          artist: album.artist,
          album: album.title,
          state: 'active',
          error: null,
          items,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        json(201, { job: wire(job) });
      });
    }

    if (path === '/addon/v1/jobs' && req.method === 'GET') {
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('since') ?? '') || 0;
      return json(200, { jobs: jobs.filter((j) => j.updatedAt > since).map(wire) });
    }

    const fileMatch = path.match(/^\/addon\/v1\/jobs\/([^/]+)\/files\/(.+)$/);
    if (fileMatch && req.method === 'GET') {
      const item = jobs
        .find((j) => j.id === fileMatch[1])
        ?.items.find((i) => i.itemId === decodeURIComponent(fileMatch[2]!));
      if (!item) return json(404, { error: 'not found' });
      if (!item.fileReady) return json(409, { error: 'not ready' });
      const bytes = readFileSync(item.path);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
      });
      return res.end(bytes);
    }

    const cancelMatch = path.match(/^\/addon\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const job = jobs.find((j) => j.id === cancelMatch[1]);
      if (!job) return json(404, { error: 'not found' });
      job.state = 'cancelled';
      job.updatedAt = Date.now();
      return json(200, { ok: true });
    }

    const jobMatch = path.match(/^\/addon\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'DELETE') {
      const idx = jobs.findIndex((j) => j.id === jobMatch[1]);
      if (idx >= 0) jobs.splice(idx, 1);
      return json(200, { ok: true });
    }
    if (jobMatch && req.method === 'GET') {
      const job = jobs.find((j) => j.id === jobMatch[1]);
      return job ? json(200, { job: wire(job) }) : json(404, { error: 'not found' });
    }

    return json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
