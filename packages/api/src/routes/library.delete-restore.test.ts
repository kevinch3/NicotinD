/**
 * #1713: removing one track of a 7-track album and putting its file back, end to
 * end through the real scanner, the real delete route and the real curator,
 * then reading `GET /albums` (the Albums grid).
 *
 * Pins the diagnosis. The delete demotes an album with no catalog release type
 * to an EP by its track count (7 → 6), so it leaves the album-only grid; that
 * is the verdict a fresh scan of a 6-track folder gives too. A file written back
 * is invisible until something rescans it, and both real ways a file comes back
 * (the download seam's album reconcile, a full sync) restore the album.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

const { libraryRoutes } = await import('./library.js');
const { LibraryScanner } = await import('../services/library-scanner.js');
const { LibraryCurator } = await import('../services/library-curator.js');

/** The e2e suite's own 7-track album, tagged FLACs. */
const ALBUM_REL = 'E2E_Test_Artist/E2E_Test_Album';
const FIXTURE_ALBUM = join(import.meta.dir, '../../../e2e/fixtures/music', ALBUM_REL);
const TRACK = '04 - Quiet_Hours.flac';

let musicDir: string;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  musicDir = mkdtempSync(join(tmpdir(), 'delete-restore-'));
  cpSync(FIXTURE_ALBUM, join(musicDir, ALBUM_REL), { recursive: true });
});
afterEach(() => {
  testDb.close();
  rmSync(musicDir, { recursive: true, force: true });
});

async function setup() {
  const scanner = new LibraryScanner(musicDir, testDb);
  const curator = new LibraryCurator(testDb);
  await scanner.scanFull();
  curator.reclassifyAll('test');
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u', username: 'admin', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(musicDir, { curator }));
  const gridNames = async () =>
    ((await (await app.request('/albums?size=500')).json()) as Array<{ name: string }>).map(
      (a) => a.name,
    );
  const abs = join(musicDir, ALBUM_REL, TRACK);
  const snapshot = readFileSync(abs);
  const { id } = testDb
    .query<{ id: string }, []>(`SELECT id FROM library_songs WHERE title = 'Quiet Hours'`)
    .get()!;
  const res = await app.request(`/songs/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  return { scanner, curator, gridNames, restore: () => writeFileSync(abs, snapshot) };
}

const classification = () =>
  testDb.query<{ c: string }, []>(`SELECT classification AS c FROM library_albums`).get()!.c;

describe('a removed track whose file comes back (#1713)', () => {
  it('the delete demotes the 6-track album to an EP, and a bare file write changes nothing', async () => {
    const { gridNames, restore } = await setup();
    expect(classification()).toBe('ep');
    expect(await gridNames()).toEqual([]);
    restore();
    expect(await gridNames()).toEqual([]);
  });

  it('the download seam (album reconcile + scoped reclassify) puts it back in the grid', async () => {
    const { scanner, curator, gridNames, restore } = await setup();
    restore();
    curator.reclassify(await scanner.reconcileAlbums([join(musicDir, ALBUM_REL)]), 'test');
    expect(await gridNames()).toEqual(['E2E Test Album']);
  });

  it('a full sync (scan + reclassify) puts it back in the grid', async () => {
    const { scanner, curator, gridNames, restore } = await setup();
    restore();
    await scanner.scanFull();
    curator.reclassifyAll('test');
    expect(classification()).toBe('album');
    expect(await gridNames()).toEqual(['E2E Test Album']);
  });
});
