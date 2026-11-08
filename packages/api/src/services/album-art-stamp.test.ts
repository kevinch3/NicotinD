/**
 * #1752: a cover that changes on disk bumps its album's cover_rev. The writers
 * in the app bump it for a cover set through the app; a hand-swapped cover.jpg
 * or new folder art used to keep the old rev, so the versioned cover URL kept
 * serving the old bytes. End to end through the real scanner over the e2e
 * fixture album (7 tagged FLACs + cover.jpg).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';
import { libraryEvents, type StampedEvent } from './library-events.js';

const ALBUM_REL = 'E2E_Test_Artist/E2E_Test_Album';
const FIXTURE_ALBUM = join(import.meta.dir, '../../../e2e/fixtures/music', ALBUM_REL);

let db: Database;
let musicDir: string;
let scanner: LibraryScanner;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  musicDir = mkdtempSync(join(tmpdir(), 'art-stamp-'));
  cpSync(FIXTURE_ALBUM, join(musicDir, ALBUM_REL), { recursive: true });
  scanner = new LibraryScanner(musicDir, db);
  libraryEvents.flush();
});
afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

const album = () =>
  db
    .query<{ id: string; cover_rev: number; art_stamp: string | null }, []>(
      'SELECT id, cover_rev, art_stamp FROM library_albums',
    )
    .get()!;

async function scanCollecting(): Promise<StampedEvent[]> {
  const seen: StampedEvent[] = [];
  const off = libraryEvents.on((e) => seen.push(e));
  try {
    await scanner.scanFull();
    libraryEvents.flush();
  } finally {
    off();
  }
  return seen;
}
const artworkChanges = (events: StampedEvent[]) =>
  events.flatMap((e) => (e.event.type === 'artwork.changed' ? e.event.changes : []));

describe('on-disk cover changes bump cover_rev (#1752)', () => {
  it('the first scan records the stamp without bumping (no deploy churn)', async () => {
    const events = await scanCollecting();
    const a = album();
    expect(a.art_stamp).toMatch(/^f\|/); // the folder's cover.jpg
    expect(a.cover_rev).toBe(0);
    expect(artworkChanges(events)).toEqual([]);
  });

  it('an unchanged rescan bumps nothing', async () => {
    await scanner.scanFull();
    const before = album();
    const events = await scanCollecting();
    expect(album()).toEqual(before);
    expect(artworkChanges(events)).toEqual([]);
  });

  it('a swapped cover.jpg bumps the rev once and announces it', async () => {
    await scanner.scanFull();
    const { id } = album();
    writeFileSync(join(musicDir, ALBUM_REL, 'cover.jpg'), Buffer.alloc(2048, 7));
    utimesSync(join(musicDir, ALBUM_REL, 'cover.jpg'), new Date(), new Date(Date.now() + 5000));
    const events = await scanCollecting();
    expect(album().cover_rev).toBe(1);
    expect(artworkChanges(events)).toEqual([{ kind: 'album', id, rev: 1 }]);
    // And the next unchanged scan leaves it there.
    await scanner.scanFull();
    expect(album().cover_rev).toBe(1);
  });

  it('a folder that loses its image is a change too (folder → embedded art)', async () => {
    await scanner.scanFull();
    rmSync(join(musicDir, ALBUM_REL, 'cover.jpg'));
    await scanCollecting();
    const a = album();
    expect(a.cover_rev).toBe(1);
    expect(a.art_stamp).toMatch(/^e\|/);
  });
});
