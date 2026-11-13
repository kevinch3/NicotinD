/**
 * Records the static demo's snapshot from the REAL server (docs/demo-mode.md).
 *
 * For each run: a fresh server over the CC library, the stand-in Lidarr and
 * addon serving the CC catalog, and Chromium driving the real SPA. Every `/api`
 * response the page receives is stored under `requestKey`; templated GETs seen
 * for one song/album/artist are then fetched for every other one, so a visitor
 * can open any page. A Get is recorded as a timeline from the trigger to the
 * album landing; after it, the whole crawl runs again as the next phase.
 *
 *   run 1: '' → Get A → 'A' → Get B → 'A|B'      run 2: '' → Get B → 'B'
 *
 * Output (`--out`, default packages/web/dist-demo/browser):
 *   demo-data/snapshot.json, demo-media/{covers,remote,audio}/…
 *
 *   bun run packages/e2e/demo/record-snapshot.ts [--out DIR] [--skip-audio]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import {
  chromium,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { chromiumLaunchOptions } from '../tour/chromium.js';
import { ensureWebBuild } from '../ensure-web-build.js';
import { startDemoAddon, DEMO_ADDON_ID, DEMO_ADDON_TOKEN } from '../tour/demo-addon.js';
import { startDemoLidarr } from '../tour/demo-lidarr.js';
import { CC_MUSIC_DIR, ccCatalog, layOutCcLibrary } from './cc-catalog.js';
import { loadManifest } from './manifest.js';
import {
  phaseId,
  requestKey,
  type DemoEntry,
  type DemoGet,
  type DemoSnapshot,
  type DemoTimelineEntry,
} from '../../web/src/app/demo/demo-snapshot.js';
import { demoHash } from '../../web/src/app/lib/demo-media.js';

const REPO = resolve(import.meta.dir, '../../..');
const args = process.argv.slice(2);
const OUT = resolve(
  args.includes('--out')
    ? args[args.indexOf('--out') + 1]!
    : join(REPO, 'packages/web/dist-demo/browser'),
);
const SKIP_AUDIO = args.includes('--skip-audio');
const PORT = Number(process.env.DEMO_RECORD_PORT ?? 8695);
const LIDARR_PORT = PORT + 1;
const ADDON_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
/** The no-match search the snapshot answers unknown queries with. */
const NO_MATCH = 'zzqx';

type AlbumRef = { artist: string; title: string };
const albumKey = (a: AlbumRef) => `${a.artist}\u0000${a.title}`;

const started = Date.now();
const log = (...parts: unknown[]) =>
  console.log(`[${Math.round((Date.now() - started) / 1000)}s]`, ...parts);

/** Set when the recorded server process exits, so no wait outlives it. */
let serverDied = false;

async function poll<T>(
  what: string,
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined as T);
    if (v !== undefined && done(v)) return v;
    if (serverDied) throw new Error(`the server exited while waiting for ${what}`);
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(500);
  }
}

interface Recorder {
  entries: Record<string, DemoEntry>;
  timeline: DemoTimelineEntry[] | null;
  t0: number;
  covers: Map<string, Buffer>;
}

/** Body reads still in flight; a navigation must wait for them (`settle`). */
const pending = new Set<Promise<void>>();

/** Every in-flight body read has landed: call before the page navigates away. */
export async function settle(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Store every `/api` JSON response the page gets, and every cover image. A
 * body is readable only until the page navigates, so every read is tracked
 * and `settle()` drains them before each navigation.
 */
function attach(page: Page, rec: Recorder): void {
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (!url.pathname.startsWith('/api/')) return;
    if (/^\/api\/(stream|ws)\/|\/events$|\/stream$/.test(url.pathname)) return;
    const req = res.request();
    const path = `${url.pathname}${url.search}`;
    const timeline = rec.timeline;
    const at = Date.now() - rec.t0;
    const read = (async () => {
      try {
        if (url.pathname.startsWith('/api/cover/')) {
          if (res.ok()) rec.covers.set(path, await res.body());
          return;
        }
        if (!(res.headers()['content-type'] ?? '').includes('json')) return;
        const entry: DemoEntry = { status: res.status(), body: await res.json() };
        const key = requestKey(req.method(), path);
        if (timeline) timeline.push({ ...entry, key, t: at });
        else rec.entries[key] = entry;
      } catch {
        // A body the page discarded anyway.
      }
    })();
    pending.add(read);
    void read.finally(() => pending.delete(read));
  });
}

/**
 * The library's entity ids, read from the API rather than from what the page
 * happened to fetch: songs come from each album's detail.
 */
async function libraryIds(api: APIRequestContext, token: string) {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const list = async (path: string) =>
    ((await (await api.get(path, auth)).json().catch(() => [])) as Array<{ id: string }>).map(
      (x) => x.id,
    );
  const albums = new Set(
    await list('/api/library/albums?type=alphabeticalByName&size=500&offset=0'),
  );
  const artists = new Set(await list('/api/library/artists'));
  const songs = new Set<string>();
  for (const id of albums) {
    const detail = (await (
      await api.get(`/api/library/albums/${id}`, auth)
    )
      .json()
      .catch(() => ({}))) as {
      song?: Array<{ id: string }>;
    };
    for (const song of detail.song ?? []) songs.add(song.id);
  }
  return { albums, artists, songs };
}

/**
 * Every recorded GET whose path names one entity, re-requested for every other
 * entity of that kind — the pages the crawl did not open by hand.
 */
async function expandTemplates(
  api: APIRequestContext,
  token: string,
  entries: Record<string, DemoEntry>,
) {
  const ids = await libraryIds(api, token);
  const kinds = [ids.songs, ids.albums, ids.artists];
  const templates = new Map<string, Set<string>>();
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('GET ')) continue;
    // Only a key naming exactly one entity is a template: one naming several
    // (a radio request's seed plus its exclusions) would multiply per id.
    const named = kinds.flatMap((set) =>
      [...set].filter((id) => key.includes(id)).map((id) => ({ id, set })),
    );
    if (named.length === 1) templates.set(key.replace(named[0]!.id, '\u0001'), named[0]!.set);
  }
  log(
    `  expanding ${templates.size} templates over ${ids.albums.size} albums, ${ids.artists.size} artists, ${ids.songs.size} songs`,
  );
  for (const [shape, set] of templates) {
    for (const id of set) {
      const key = shape.replace('\u0001', id);
      if (entries[key]) continue;
      const res = await api.get(key.slice(4), { headers: { Authorization: `Bearer ${token}` } });
      if (!(res.headers()['content-type'] ?? '').includes('json')) continue;
      entries[key] = { status: res.status(), body: await res.json().catch(() => null) };
    }
  }
  return ids;
}

/** Every `coverArt` id and server-built cover URL anywhere in the bodies. */
function collectCoverRefs(value: unknown, ids: Set<string>, remotes: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) collectCoverRefs(v, ids, remotes);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'coverArt' && typeof v === 'string' && v && !v.includes('/')) ids.add(v);
      else if (typeof v === 'string' && v.startsWith('/api/cover/remote?')) remotes.add(v);
      else collectCoverRefs(v, ids, remotes);
    }
  }
}

async function crawl(
  page: Page,
  api: APIRequestContext,
  token: string,
  rec: Recorder,
  artists: string[],
) {
  const visit = async (path: string) => {
    log(`  visit ${path}`);
    await settle();
    await page.goto(path);
    await page.waitForTimeout(1500);
  };
  for (const path of [
    '/',
    '/classic',
    '/library',
    '/get',
    '/get?tab=activity',
    '/settings',
    '/settings/about',
    '/settings/account',
    '/settings/recommendations',
    '/admin',
    '/settings/plugins',
  ]) {
    await visit(path);
  }
  // The library's tabs are lazy: each list loads on its first switch.
  await visit('/library');
  const tabs = page.getByTestId('library-tabs').getByRole('button');
  for (let i = 0; i < (await tabs.count()); i++) {
    await tabs
      .nth(i)
      .click()
      .catch(() => {});
    await page.waitForTimeout(1500);
  }
  const albums = (await (
    await api.get('/api/library/albums', { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string; artistId?: string }>;
  const first = albums[0];
  if (first) {
    await visit(`/library/albums/${first.id}`);
    // Play the first track: records the player's per-song calls (waveform,
    // lyrics, radio) that template expansion then repeats for every song.
    // Now Playing fetches them only once open, tab by tab.
    for (const id of [
      'play-album',
      'player-track-info',
      'now-playing-tab-lyrics',
      'now-playing-tab-queue',
      'now-playing-radio',
    ]) {
      await page
        .getByTestId(id)
        .first()
        .click({ timeout: 10_000 })
        .catch(() => log(`  (no ${id} to click)`));
      await page.waitForTimeout(2000);
    }
    await page.keyboard.press('Escape');
    if (first.artistId) await visit(`/library/artists/${first.artistId}`);
  }
  for (const term of [...artists, NO_MATCH]) {
    await visit('/get');
    await page.getByTestId('search-input').fill(term);
    await page.getByTestId('search-submit').click();
    await page.waitForTimeout(1500);
    await page.waitForTimeout(1500);
  }
  await settle();
  return expandTemplates(api, token, rec.entries);
}

/** Drive one Get through the UI and keep its timeline. */
async function recordGet(
  page: Page,
  api: APIRequestContext,
  token: string,
  rec: Recorder,
  album: { artist: string; title: string },
): Promise<DemoGet> {
  log(`get ${album.artist} — ${album.title}`);
  await settle();
  await page.goto('/get');
  await page.getByTestId('search-input').fill(album.artist);
  await page.getByTestId('search-submit').click();
  const card = page.getByRole('gridcell', {
    name: new RegExp(`^${album.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  });
  await card.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  const writes: Array<{ method: string; path: string; status: number; body: unknown; at: number }> =
    [];
  const onWrite = async (res: import('@playwright/test').Response) => {
    const req = res.request();
    const url = new URL(res.url());
    if (req.method() === 'GET' || !url.pathname.startsWith('/api/')) return;
    // Player and session chatter is not the Get.
    if (
      /^\/api\/(history|scrobble|queue|playback|player|me|auth|preferences|radio)(\/|$)/.test(
        url.pathname,
      )
    )
      return;
    writes.push({
      method: req.method(),
      path: url.pathname,
      status: res.status(),
      body: await res.json().catch(() => ({})),
      at: Date.now(),
    });
  };
  page.on('response', onWrite);
  rec.t0 = Date.now();
  rec.timeline = [];
  await card.getByTestId('catalog-album-cover').click();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  await poll(
    `${album.title} to land`,
    async () => {
      // Sampled twice a second into the timeline: the SPA, with SSE live,
      // polls too rarely for the replay to show the download progressing.
      const res = await api.get('/api/downloads/jobs', auth);
      const jobs = (await res.json()) as Array<{ albumTitle: string | null; stage: string }>;
      rec.timeline?.push({
        key: requestKey('GET', '/api/downloads/jobs'),
        status: res.status(),
        body: jobs,
        t: Date.now() - rec.t0,
      });
      return jobs;
    },
    (jobs) => jobs.some((j) => j.albumTitle === album.title && j.stage === 'done'),
  );
  // The SPA polls on its own clock; give it a beat to see the finished job.
  await page.waitForTimeout(4000);
  await settle();
  page.off('response', onWrite);
  const timeline = rec.timeline;
  rec.timeline = null;
  const trigger = writes[0];
  if (!trigger) throw new Error(`no write fired for the Get of ${album.title}`);
  const shift = trigger.at - rec.t0;
  return {
    album: albumKey(album),
    title: album.title,
    trigger: {
      method: trigger.method,
      path: trigger.path,
      status: trigger.status,
      body: trigger.body,
    },
    durationMs: Date.now() - trigger.at,
    timeline: timeline.map((e) => ({ ...e, t: Math.max(0, e.t - shift) })),
  };
}

async function startServer(dataDir: string, musicDir: string) {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      NICOTIND_PORT: String(PORT),
      NICOTIND_MODE: 'external',
      NICOTIND_SLSKD_URL: 'http://127.0.0.1:1',
      NICOTIND_LIDARR_URL: `http://127.0.0.1:${LIDARR_PORT}`,
      LIDARR_API_KEY: 'demo',
      NICOTIND_DATA_DIR: dataDir,
      NICOTIND_MUSIC_DIR: musicDir,
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  await poll(
    'the server',
    () => fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok),
    Boolean,
    90_000,
  );
  return proc;
}

async function run(
  steps: Array<{ get: AlbumRef } | { forget: AlbumRef }>,
  snapshot: DemoSnapshot,
  covers: Map<string, Buffer>,
  songs: Set<string>,
) {
  const scratch = mkdtempSync(join(tmpdir(), 'nicotind-demo-'));
  const musicDir = join(scratch, 'music');
  cpSync(CC_MUSIC_DIR, musicDir, { recursive: true });
  const catalog = ccCatalog();
  const services: Server[] = [
    await startDemoLidarr(LIDARR_PORT, catalog),
    await startDemoAddon(ADDON_PORT, catalog),
  ];
  serverDied = false;
  const server = await startServer(join(scratch, 'data'), musicDir);
  void server.exited.then(() => (serverDied = true));
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const api = await pwRequest.newContext({ baseURL: BASE });
    const setup = await api.post('/api/setup/complete', {
      data: { admin: { username: 'demo', password: 'demo-password-123' } },
    });
    if (setup.status() !== 201) throw new Error(`setup: ${setup.status()} ${await setup.text()}`);
    const token = ((await setup.json()) as { token: string }).token;
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    log('setup step');
    await api.post('/api/system/scan', auth);
    await poll(
      'the scan',
      async () =>
        ((await (await api.get('/api/system/scan/status', auth)).json()) as { scanning: boolean })
          .scanning,
      (s) => s === false,
    );
    await poll(
      'processing to idle',
      async () =>
        (
          (await (await api.get('/api/admin/processing', auth)).json().catch(() => ({}))) as {
            status?: { phase?: string };
          }
        ).status?.phase ?? 'none',
      (p) => p !== 'running',
    );
    log('setup step');
    const reg = await api.post('/api/plugins/addons', {
      ...auth,
      data: { url: `http://127.0.0.1:${ADDON_PORT}`, token: DEMO_ADDON_TOKEN },
    });
    if (reg.status() !== 201) throw new Error(`addon: ${reg.status()} ${await reg.text()}`);
    await api.post(`/api/plugins/${DEMO_ADDON_ID}/enable`, { ...auth, data: { consent: true } });
    await api.post('/api/auth/dismiss-welcome', auth);

    const context = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(
      ({ t }) => {
        localStorage.setItem('nicotind_token', t);
        localStorage.setItem('nicotind_username', 'demo');
        localStorage.setItem('nicotind_role', 'admin');
      },
      { t: token },
    );
    const page = await context.newPage();
    const rec: Recorder = { entries: {}, timeline: null, t0: 0, covers };
    attach(page, rec);
    const artistNames = [...new Set(catalog.map((a) => a.artist))];
    const acquired: string[] = [];

    const recordPhase = async () => {
      rec.entries = {};
      const ids = await crawl(page, api, token, rec, artistNames);
      // A visitor who signs out signs back in with anything: the login page
      // gets the recorded answer of a real login.
      const login = await api.post('/api/auth/login', {
        data: { username: 'demo', password: 'demo-password-123' },
      });
      rec.entries[requestKey('POST', '/api/auth/login')] = {
        status: login.status(),
        body: await login.json(),
      };
      for (const s of ids.songs) songs.add(s);
      snapshot.phases[phaseId(acquired)] = rec.entries;
      if (process.env.DEMO_RECORD_DEBUG) {
        mkdirSync(join(OUT, 'demo-data'), { recursive: true });
        writeFileSync(
          join(OUT, 'demo-data', `keys-${Object.keys(snapshot.phases).length}.json`),
          JSON.stringify(Object.keys(rec.entries), null, 1),
        );
      }
      log(`phase '${phaseId(acquired)}': ${Object.keys(rec.entries).length} responses`);
    };
    const idle = () =>
      poll(
        'processing to idle',
        async () =>
          (
            (await (await api.get('/api/admin/processing', auth)).json().catch(() => ({}))) as {
              status?: { phase?: string };
            }
          ).status?.phase ?? 'none',
        (p) => p !== 'running',
      );
    await recordPhase();
    for (const step of steps) {
      if ('forget' in step) {
        // Back to the state before this album's Get: the album and its job go.
        const album = step.forget;
        log(`forget ${album.artist} — ${album.title}`);
        const albums = (await (
          await api.get('/api/library/albums?type=alphabeticalByName&size=500&offset=0', auth)
        ).json()) as Array<{ id: string; name: string }>;
        for (const a of albums.filter((x) => x.name === album.title)) {
          const res = await api.delete(`/api/library/albums/${a.id}`, auth);
          if (!res.ok())
            throw new Error(`delete ${album.title}: ${res.status()} ${await res.text()}`);
        }
        const jobs = (await (await api.get('/api/downloads/jobs', auth)).json()) as Array<{
          id: string;
          albumTitle: string | null;
        }>;
        for (const j of jobs.filter((x) => x.albumTitle === album.title)) {
          await api.delete(`/api/downloads/jobs/${j.id}`, auth);
        }
        acquired.splice(acquired.indexOf(albumKey(album)), 1);
        await idle();
        continue;
      }
      const album = step.get;
      const get = await recordGet(page, api, token, rec, album);
      if (!snapshot.gets.some((g) => g.album === get.album)) snapshot.gets.push(get);
      acquired.push(albumKey(album));
      await idle();
      // A phase recorded already (A after A's second Get) is not crawled again.
      if (!snapshot.phases[phaseId(acquired)]) await recordPhase();
    }

    // Covers the bodies name but the page never drew.
    const ids = new Set<string>();
    const remotes = new Set<string>();
    for (const phase of Object.values(snapshot.phases))
      for (const e of Object.values(phase)) collectCoverRefs(e.body, ids, remotes);
    for (const id of ids) {
      const path = `/api/cover/${id}?size=300&token=${token}`;
      if ([...covers.keys()].some((k) => k.startsWith(`/api/cover/${id}?`))) continue;
      const res = await api.get(path);
      if (res.ok()) covers.set(path, await res.body());
    }
    for (const remote of remotes) {
      if (covers.has(remote)) continue;
      const res = await api.get(`${remote}&token=${token}`);
      if (res.ok()) covers.set(remote, await res.body());
    }
    if (!SKIP_AUDIO) await writeAudio(api, token, songs);
  } catch (err) {
    log(`run error: ${(err as Error).stack ?? err}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
    // A server that ignores SIGTERM must not wedge the recorder.
    server.kill();
    const exited = await Promise.race([
      server.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!exited) {
      server.kill(9);
      await server.exited;
    }
    for (const s of services) (s.closeAllConnections?.(), s.close());
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0)
    throw new Error(`ffmpeg: ${await new Response(proc.stderr).text()}`);
}

/** Each song's bytes from the real stream route, as Opus/WebM plus an AAC fallback. */
async function writeAudio(
  api: APIRequestContext,
  token: string,
  songs: Set<string>,
): Promise<void> {
  const dir = join(OUT, 'demo-media/audio');
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'nicotind-demo-audio-'));
  for (const id of songs) {
    const webm = join(dir, `${id}.webm`);
    const m4a = join(dir, `${id}.m4a`);
    if (existsSync(webm) && existsSync(m4a)) continue;
    const res = await api.get(`/api/stream/${id}?token=${token}`);
    if (!res.ok()) throw new Error(`stream ${id}: ${res.status()}`);
    const src = join(tmp, id);
    writeFileSync(src, await res.body());
    await ffmpeg(['-i', src, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '64k', webm]);
    await ffmpeg([
      '-i',
      src,
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      'aac',
      '-b:a',
      '80k',
      '-movflags',
      '+faststart',
      m4a,
    ]);
  }
  rmSync(tmp, { recursive: true, force: true });
}

function writeCovers(covers: Map<string, Buffer>): void {
  // The largest of the sizes recorded for one cover wins.
  const best = new Map<string, Buffer>();
  for (const [path, bytes] of covers) {
    const [p = '', q = ''] = path.split('?');
    const file =
      p === '/api/cover/remote'
        ? `remote/${demoHash(new URLSearchParams(q).get('u') ?? '')}.jpg`
        : `covers/${p.slice('/api/cover/'.length)}.jpg`;
    if ((best.get(file)?.length ?? 0) < bytes.length) best.set(file, bytes);
  }
  for (const [file, bytes] of best) {
    const dest = join(OUT, 'demo-media', file);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, bytes);
  }
  log(`${best.size} cover images`);
}

if (import.meta.main) {
  ensureWebBuild();
  if (!existsSync(CC_MUSIC_DIR)) await layOutCcLibrary();
  const held = loadManifest().albums.filter((a) => a.heldBack);
  if (held.length !== 2)
    throw new Error(`the recorder expects 2 held-back albums, found ${held.length}`);
  const [a, b] = held as [(typeof held)[0], (typeof held)[0]];
  const snapshot: DemoSnapshot = { version: 1, phases: {}, gets: [] };
  const covers = new Map<string, Buffer>();
  const songs = new Set<string>();
  // One server, every phase: '' → Get A → 'A' → forget A → Get B → 'B' →
  // Get A → 'A|B'. Each Get's timeline starts from the base library.
  await run([{ get: a }, { forget: a }, { get: b }, { get: a }], snapshot, covers, songs);
  mkdirSync(join(OUT, 'demo-data'), { recursive: true });
  // A later phase repeats most of the base; it keeps only what differs, and
  // DemoServer answers the rest from the base.
  const base = snapshot.phases[''] ?? {};
  for (const [id, phase] of Object.entries(snapshot.phases)) {
    if (id === '') continue;
    for (const [key, entry] of Object.entries(phase)) {
      if (base[key] && JSON.stringify(base[key]) === JSON.stringify(entry)) delete phase[key];
    }
  }
  writeFileSync(join(OUT, 'demo-data/snapshot.json'), JSON.stringify(snapshot));
  // The CC licences require attribution; the demo banner lists these.
  const credits = loadManifest().albums.map(({ artist, title, licence, sourceUrl }) => ({
    artist,
    title,
    licence,
    sourceUrl,
  }));
  writeFileSync(join(OUT, 'demo-data/credits.json'), JSON.stringify(credits));
  writeCovers(covers);
  log(
    `snapshot: ${Object.keys(snapshot.phases).join(', ') || '(none)'}; ${snapshot.gets.length} gets; ${songs.size} songs`,
  );
}
