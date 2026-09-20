/**
 * Tests for the Opus cover-art embed pass.
 *
 * Real `.opus` files via ffmpeg + a real in-memory DB, because the thing under
 * test is whether a picture actually lands in a file the app can read back —
 * a mocked writer would assert only that we called it.
 *
 * The `ci` gate job has no ffmpeg, so the apply-path cases skip there and the
 * `e2e` job is what exercises them.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { embedAlbumArt } from './opus-art-embed.js';
import { songId } from './library-scanner.js';
import { ffmpegAvailable } from './transcode.js';
import { extractEmbeddedPicture } from './cover-sources.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpMusic() {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'nicotind-artembed-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A real, tiny .opus with no embedded picture. */
function makeOpus(musicDir: string, rel: string): void {
  const dest = join(musicDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t',
      '0.4',
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'ogg',
      '-y',
      dest,
    ],
    { stdio: 'ignore' },
  );
}

/** A real JPEG of noise, so it cannot be confused with another fixture. */
function makeCover(path: string, px = 300): number {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `nullsrc=s=${px}x${px},geq=random(1)*255:128:128`,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
  return px;
}

function seedAlbum(
  db: Database,
  albumId: string,
  name: string,
  rels: string[],
  opts: { coverUrl?: string } = {},
): void {
  // Plain INSERT, never `OR IGNORE`: a seed that silently fails leaves the
  // query under test with nothing to find and the test asserting on an empty
  // library. `synced_at` is NOT NULL with no default.
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, hidden, synced_at)
     VALUES (?, ?, 'The Artist', 'art', ?, 0, 1)`,
    [albumId, name, rels.length],
  );
  for (const rel of rels) {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix,
                                  size, duration, hidden, synced_at, has_embedded_art)
       VALUES (?, ?, 'T', 'The Artist', 'art', ?, 'opus', 1000, 10, 0, 1, 0)`,
      [songId(rel), albumId, rel],
    );
  }
  if (opts.coverUrl) {
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES (?, 'album', ?, 1)`,
      [albumId, opts.coverUrl],
    );
  }
}

const artOf = async (p: string) => (await extractEmbeddedPicture(p))?.data.length ?? 0;

describe.skipIf(!ffmpegAvailable())('embedAlbumArt — folder image source', () => {
  it('writes the folder cover into every track of the album', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rels = ['The Artist/Album/01 - A.opus', 'The Artist/Album/02 - B.opus'];
    for (const r of rels) makeOpus(music, r);
    makeCover(join(music, 'The Artist/Album/cover.jpg'));
    seedAlbum(db, 'alb1', 'Album', rels);

    const r = await embedAlbumArt(db, music, { apply: true });

    expect(r.albumsEmbedded).toBe(1);
    expect(r.tracksEmbedded).toBe(2);
    for (const rel of rels) expect(await artOf(join(music, rel))).toBeGreaterThan(0);
  });

  it('sets has_embedded_art, so a later pass does not redo the album', async () => {
    // Only the scanner writes this column, and its upsert COALESCEs — a rescan
    // would keep the stale 0 and every later pass would re-embed the same art.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Album/01 - A.opus';
    makeOpus(music, rel);
    makeCover(join(music, 'The Artist/Album/cover.jpg'));
    seedAlbum(db, 'alb1', 'Album', [rel]);

    await embedAlbumArt(db, music, { apply: true });
    const again = await embedAlbumArt(db, music, { apply: true });

    expect(
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) n FROM library_songs WHERE has_embedded_art = 1`)
        .get()?.n,
    ).toBe(1);
    expect(again.albums).toBe(0);
    expect(again.tracksEmbedded).toBe(0);
  });

  it('refuses a shared bucket’s cover', async () => {
    // #978: one stray cover.jpg had become the cover of 1,229 unrelated albums.
    // Rendering that is wrong; baking it into the files makes it permanent.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const mine = 'Various Artists/Singles/01 - Mine.opus';
    const theirs = 'Various Artists/Singles/02 - Theirs.opus';
    for (const r of [mine, theirs]) makeOpus(music, r);
    makeCover(join(music, 'Various Artists/Singles/cover.jpg'));
    seedAlbum(db, 'alb1', 'Mine', [mine]);
    seedAlbum(db, 'alb2', 'Theirs', [theirs]); // two albums, one directory

    const r = await embedAlbumArt(db, music, { apply: true });

    expect(r.tracksEmbedded).toBe(0);
    expect(r.sharedBucket).toBe(2);
    expect(await artOf(join(music, mine))).toBe(0);
  });

  it('counts an album with no cover anywhere instead of failing it', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Bare/01 - A.opus';
    makeOpus(music, rel);
    seedAlbum(db, 'alb1', 'Bare', [rel]);

    const r = await embedAlbumArt(db, music, { apply: true });

    expect(r.noSource).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.albumsEmbedded).toBe(0);
  });

  it('leaves the files alone on a dry run', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Album/01 - A.opus';
    makeOpus(music, rel);
    makeCover(join(music, 'The Artist/Album/cover.jpg'));
    seedAlbum(db, 'alb1', 'Album', [rel]);

    const r = await embedAlbumArt(db, music, { apply: false });

    expect(r.tracksEmbedded).toBe(1); // would-embed count
    expect(await artOf(join(music, rel))).toBe(0);
    expect(
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) n FROM library_songs WHERE has_embedded_art = 1`)
        .get()?.n,
    ).toBe(0);
  });

  it('leaves no scratch files beside the tracks', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Album/01 - A.opus';
    makeOpus(music, rel);
    makeCover(join(music, 'The Artist/Album/cover.jpg'));
    seedAlbum(db, 'alb1', 'Album', [rel]);

    await embedAlbumArt(db, music, { apply: true });

    const leaked = readdirSync(join(music, 'The Artist/Album')).filter((n) =>
      n.includes('nicotind-art'),
    );
    expect(leaked).toEqual([]);
  });
});

describe.skipIf(!ffmpegAvailable())('embedAlbumArt — remote cover source', () => {
  function jpegResponse(bytes: Uint8Array): Response {
    // `Buffer` is not a `BodyInit`; a plain `Uint8Array` view over the same
    // bytes is, and typecheck is the only thing that catches this — `bun test`
    // type-checks nothing.
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }

  it('fetches the artwork row’s url when there is no folder image', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Remote/01 - A.opus';
    makeOpus(music, rel);
    const src = join(music, 'src.jpg');
    makeCover(src);
    const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
    rmSync(src);
    seedAlbum(db, 'alb1', 'Remote', [rel], { coverUrl: 'https://example.invalid/c.jpg' });

    const r = await embedAlbumArt(db, music, {
      apply: true,
      fetchFn: (async () => jpegResponse(bytes)) as unknown as typeof fetch,
    });

    expect(r.tracksEmbedded).toBe(1);
    expect(await artOf(join(music, rel))).toBeGreaterThan(0);
  });

  it('never fetches under localOnly', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Remote/01 - A.opus';
    makeOpus(music, rel);
    seedAlbum(db, 'alb1', 'Remote', [rel], { coverUrl: 'https://example.invalid/c.jpg' });

    let calls = 0;
    const r = await embedAlbumArt(db, music, {
      apply: true,
      localOnly: true,
      fetchFn: (async () => {
        calls += 1;
        return jpegResponse(new Uint8Array(10));
      }) as unknown as typeof fetch,
    });

    expect(calls).toBe(0);
    expect(r.noSource).toBe(1);
  });

  it('counts an unreachable host without ending the pass', async () => {
    // One bad row must not stop a pass over hundreds of albums.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const bad = 'The Artist/Bad/01 - A.opus';
    const good = 'The Artist/Good/01 - A.opus';
    for (const r of [bad, good]) makeOpus(music, r);
    makeCover(join(music, 'The Artist/Good/cover.jpg'));
    seedAlbum(db, 'alb1', 'Bad', [bad], { coverUrl: 'https://example.invalid/c.jpg' });
    seedAlbum(db, 'alb2', 'Good', [good]);

    const r = await embedAlbumArt(db, music, {
      apply: true,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    expect(r.fetchFailed).toBe(1);
    expect(r.tracksEmbedded).toBe(1); // the good album still converted
  });

  it('rejects a response that is not an image', async () => {
    // An HTML error page served with 200 is the common shape here, and
    // embedding it would produce a file whose "cover" is a login form.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Remote/01 - A.opus';
    makeOpus(music, rel);
    seedAlbum(db, 'alb1', 'Remote', [rel], { coverUrl: 'https://example.invalid/c.jpg' });

    const r = await embedAlbumArt(db, music, {
      apply: true,
      fetchFn: (async () =>
        new Response('<html>nope</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    });

    expect(r.fetchFailed).toBe(1);
    expect(await artOf(join(music, rel))).toBe(0);
  });
});

describe.skipIf(!ffmpegAvailable())('embedAlbumArt — pagination and cancel', () => {
  function seedMany(db: Database, music: string, n: number): void {
    for (let i = 1; i <= n; i++) {
      const rel = `The Artist/Album ${i}/01 - A.opus`;
      makeOpus(music, rel);
      makeCover(join(music, `The Artist/Album ${i}/cover.jpg`), 200);
      seedAlbum(db, `alb${String(i).padStart(2, '0')}`, `Album ${i}`, [rel]);
    }
  }

  it('resumes exactly where the cursor left off', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedMany(db, music, 4);

    const first = await embedAlbumArt(db, music, { apply: true, limit: 2 });
    expect(first.albums).toBe(2);
    expect(first.stopped).toBe(true);

    const second = await embedAlbumArt(db, music, {
      apply: true,
      limit: 2,
      afterId: first.cursor,
    });

    expect(second.albums).toBe(2);
    expect(second.cursor).not.toBe(first.cursor);
    expect(
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) n FROM library_songs WHERE has_embedded_art = 1`)
        .get()?.n,
    ).toBe(4);
  });

  it('stops without touching anything when cancelled up front', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedMany(db, music, 3);

    const r = await embedAlbumArt(db, music, { apply: true, shouldStop: () => true });

    expect(r.stopped).toBe(true);
    expect(r.tracksEmbedded).toBe(0);
  });

  it('reports progress once per album, monotonically', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedMany(db, music, 3);

    const seen: number[] = [];
    await embedAlbumArt(db, music, {
      apply: true,
      onProgress: (p) => seen.push(p.visited),
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it('skips a row whose file is gone rather than throwing', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Album/01 - A.opus';
    makeOpus(music, rel);
    makeCover(join(music, 'The Artist/Album/cover.jpg'));
    seedAlbum(db, 'alb1', 'Album', [rel, 'The Artist/Album/02 - Ghost.opus']);

    const r = await embedAlbumArt(db, music, { apply: true });

    expect(r.tracksEmbedded).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('does not embed a cover it cannot cap under the reader ceiling', async () => {
    // `preparePicture` returns null when even the softest quality is too big.
    // A file the app cannot read back is worse than no file: the picker shows
    // nothing while the bytes are still paid for.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'The Artist/Album/01 - A.opus';
    makeOpus(music, rel);
    // Not a JPEG at all, so every re-compress attempt fails.
    writeFileSync(join(music, 'The Artist/Album/cover.jpg'), Buffer.alloc(2 * 1024 * 1024, 0x41));
    seedAlbum(db, 'alb1', 'Album', [rel]);

    const r = await embedAlbumArt(db, music, { apply: true });

    expect(r.tracksEmbedded).toBe(0);
    expect(await artOf(join(music, rel))).toBe(0);
  });
});
