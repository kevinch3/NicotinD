/**
 * Scoped re-bucket (#1521): a curation fix rebuilds the albums it touches from
 * cached tags instead of awaiting a whole-library scan (15.4 s on prod for a
 * one-song split). Fixture files are 8-byte placeholders whose tags live in
 * `scan_cache`, so nothing here needs ffmpeg.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner, artistIdFor, albumIdFor, songId } from './library-scanner.js';
import { saveScanCache } from './scan-cache.js';
import { upsertArtistAlias, upsertArtistIdentity } from './artist-identity-store.js';

let musicDir: string;
let db: Database;
let scanner: LibraryScanner;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'rebucket-test-'));
  db = new Database(':memory:');
  applySchema(db);
  scanner = new LibraryScanner(musicDir, db);
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

/** A placeholder file whose tags the scanner reads from its cache. */
function put(
  rel: string,
  tags: { artist: string; album: string; title: string; albumArtist?: string; genre?: string[] },
): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
  const st = statSync(abs);
  saveScanCache(db, [
    {
      relPath: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      suffix: 'mp3',
      contentType: 'audio/mpeg',
      duration: 200,
      bitRate: 320,
      albumArtist: tags.albumArtist ?? tags.artist,
      ...tags,
    },
  ]);
}

const row = (sql: string, ...params: string[]) =>
  db.query<Record<string, unknown>, string[]>(sql).get(...params);

const syncedAt = (table: string, id: string) =>
  row(`SELECT synced_at FROM ${table} WHERE id = ?`, id)?.synced_at;

describe('LibraryScanner.rebucketArtists', () => {
  it('rebuckets only the named artist’s albums', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    put('B/Two/01.mp3', { artist: 'Bravo', album: 'Two', title: 'b1' });
    await scanner.scanFull();
    const bravoBefore = syncedAt('library_albums', albumIdFor('Bravo', 'Two'));

    upsertArtistAlias(db, { aliasNorm: 'alpha', canonicalName: 'Alpha Prime', source: 'user' });
    await Bun.sleep(5);
    const result = await scanner.rebucketArtists(['Alpha', 'Alpha Prime']);

    expect(result.songs).toBe(1);
    expect(
      row('SELECT artist_id FROM library_albums WHERE id = ?', albumIdFor('Alpha Prime', 'One'))
        ?.artist_id,
    ).toBe(artistIdFor('Alpha Prime'));
    expect(syncedAt('library_albums', albumIdFor('Bravo', 'Two'))).toBe(bravoBefore);
  });

  it('drops the album and artist a rename vacates', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    await scanner.scanFull();

    upsertArtistAlias(db, { aliasNorm: 'alpha', canonicalName: 'Alpha Prime', source: 'user' });
    await scanner.rebucketArtists(['Alpha', 'Alpha Prime']);

    expect(
      row('SELECT id FROM library_albums WHERE id = ?', albumIdFor('Alpha', 'One')),
    ).toBeNull();
    expect(row('SELECT id FROM library_artists WHERE id = ?', artistIdFor('Alpha'))).toBeNull();
    expect(
      row('SELECT id FROM library_artists WHERE id = ?', artistIdFor('Alpha Prime')),
    ).not.toBeNull();
  });

  it('keeps a credit-only split member', async () => {
    put('M1/Solo/01.mp3', { artist: 'Mike One', album: 'Solo', title: 's1' });
    put('Duo/Collab/01.mp3', { artist: 'Mike One & Mike Two', album: 'Collab', title: 'c1' });
    await scanner.scanFull();
    // Mike Two never appears solo, so the scan kept the compound whole.
    expect(row('SELECT id FROM library_artists WHERE id = ?', artistIdFor('Mike Two'))).toBeNull();

    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Mike One & Mike Two'),
      rawName: 'Mike One & Mike Two',
      decision: 'split',
      members: ['Mike One', 'Mike Two'],
      source: 'user',
    });
    await scanner.rebucketArtists(['Mike One & Mike Two']);

    const credits = db
      .query<{ artist_id: string }, [string]>(
        'SELECT artist_id FROM library_song_artists WHERE song_id = ? ORDER BY position',
      )
      .all(songId('Duo/Collab/01.mp3'))
      .map((r) => r.artist_id);
    expect(credits).toEqual([artistIdFor('Mike One'), artistIdFor('Mike Two')]);
    // Owns nothing, album-credited on Collab: survives, counted as a full scan would.
    expect(
      row('SELECT album_count FROM library_artists WHERE id = ?', artistIdFor('Mike Two'))
        ?.album_count,
    ).toBe(1);
    // Owns Solo (outside the re-bucketed batch) + credited on Collab: the batch
    // alone would say 1.
    expect(
      row('SELECT album_count FROM library_artists WHERE id = ?', artistIdFor('Mike One'))
        ?.album_count,
    ).toBe(2);
    expect(
      row(
        'SELECT split_compound FROM library_artists WHERE id = ?',
        artistIdFor('Mike One & Mike Two'),
      )?.split_compound,
    ).toBe(1);
  });

  it('refreshes album_count of a merge target from all its albums', async () => {
    put('B/One/01.mp3', { artist: 'Bravo', album: 'One', title: 'b1' });
    put('B/Two/01.mp3', { artist: 'Bravo', album: 'Two', title: 'b2' });
    put('Bv/Three/01.mp3', { artist: 'Bravo Variant', album: 'Three', title: 'b3' });
    await scanner.scanFull();

    upsertArtistAlias(db, { aliasNorm: 'bravo variant', canonicalName: 'Bravo', source: 'user' });
    await scanner.rebucketArtists(['Bravo Variant', 'Bravo']);

    expect(
      row('SELECT album_count FROM library_artists WHERE id = ?', artistIdFor('Bravo'))
        ?.album_count,
    ).toBe(3);
    expect(
      row('SELECT id FROM library_artists WHERE id = ?', artistIdFor('Bravo Variant')),
    ).toBeNull();
  });

  it('recounts the genres it touched', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1', genre: ['Folk'] });
    put('A/One/02.mp3', { artist: 'Alpha', album: 'One', title: 'a2', genre: ['Folk'] });
    put('B/Two/01.mp3', { artist: 'Bravo', album: 'Two', title: 'b1', genre: ['Folk'] });
    await scanner.scanFull();

    upsertArtistAlias(db, { aliasNorm: 'alpha', canonicalName: 'Alpha Prime', source: 'user' });
    await scanner.rebucketArtists(['Alpha', 'Alpha Prime']);

    const folk = db
      .query<{ song_count: number; album_count: number }, []>(
        "SELECT song_count, album_count FROM library_genres WHERE name = 'Folk'",
      )
      .get();
    expect(folk).toEqual({ song_count: 3, album_count: 2 });
  });

  it('unknown name is a no-op', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    await scanner.scanFull();
    expect(await scanner.rebucketArtists(['Nobody At All'])).toEqual({ songs: 0, albumIds: [] });
  });

  it('skips a vanished file without deleting its row', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    put('A/One/02.mp3', { artist: 'Alpha', album: 'One', title: 'a2' });
    await scanner.scanFull();
    unlinkSync(join(musicDir, 'A/One/02.mp3'));

    await scanner.rebucketArtists(['Alpha']);

    expect(row('SELECT id FROM library_songs WHERE id = ?', songId('A/One/02.mp3'))).not.toBeNull();
  });

  // A scan builds from split/alias authority it loaded up front, so a fix
  // persisted mid-build would be overwritten by the scan's stale result. The
  // contract is ordering: a re-bucket never runs while a scan is in flight.
  it('rebucket waits for an in-flight scanFull', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    await scanner.scanFull();

    const order: string[] = [];
    const scan = scanner.scanFull().then(() => order.push('scan'));
    const rebucket = scanner.rebucketArtists(['Alpha']).then(() => order.push('rebucket'));
    await Promise.all([scan, rebucket]);

    expect(order).toEqual(['scan', 'rebucket']);
  });

  it('a failed scan does not wedge later re-buckets', async () => {
    put('A/One/01.mp3', { artist: 'Alpha', album: 'One', title: 'a1' });
    await scanner.scanFull();
    rmSync(musicDir, { recursive: true, force: true });
    await scanner.scanFull().catch(() => undefined);
    expect(await scanner.rebucketArtists(['Alpha'])).toEqual({
      songs: 0,
      albumIds: [expect.any(String)],
    });
  });
});
