import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { embeddingModelFor, loadEmbeddings } from './embedding-store.js';

const MODEL = 'discogs-effnet-bs64-1';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
  );
});

function seedSong(id: string, size: number): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 0, ?, ?, '2024-01-01', 1)`,
    [id, id, `Artist/Album/${id}.opus`, size],
  );
}

function seedEmbedding(songId: string, fileSize: number | null): void {
  db.run(
    `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
     VALUES (?, ?, 2, ?, ?, 1)`,
    [songId, MODEL, Buffer.from(new Float32Array([0.5, 0.5]).buffer), fileSize],
  );
}

describe('loadEmbeddings', () => {
  it('returns the cached vector when the file is unchanged', () => {
    seedSong('s1', 1000);
    seedEmbedding('s1', 1000);

    const out = loadEmbeddings(db, ['s1'], MODEL);
    expect(out.get('s1')).toEqual(new Float32Array([0.5, 0.5]));
  });

  /**
   * Issue #258: `song_id` is derived from the path, so a file replaced in place
   * (a re-download at better quality, a repaired rip) keeps its id — and the
   * Radio scorer would go on matching against a vector describing audio that is
   * no longer there. Silently, forever.
   */
  it('treats a changed file size as a cache miss', () => {
    seedSong('s1', 2000); // file was replaced — now a different size
    seedEmbedding('s1', 1000); // vector describes the OLD bytes

    expect(loadEmbeddings(db, ['s1'], MODEL).has('s1')).toBe(false);
  });

  it('still serves rows written before the column existed', () => {
    // An upgrade must not invalidate every embedding in the library at once.
    seedSong('s1', 1000);
    seedEmbedding('s1', null);

    expect(loadEmbeddings(db, ['s1'], MODEL).has('s1')).toBe(true);
  });

  it('drops an embedding whose song no longer exists', () => {
    seedEmbedding('ghost', 1000);
    expect(loadEmbeddings(db, ['ghost'], MODEL).has('ghost')).toBe(false);
  });

  it('short-circuits on an empty id list or missing model', () => {
    seedSong('s1', 1000);
    seedEmbedding('s1', 1000);
    expect(loadEmbeddings(db, [], MODEL).size).toBe(0);
    expect(loadEmbeddings(db, ['s1'], null).size).toBe(0);
  });

  it('mixes fresh and stale rows in one batch', () => {
    seedSong('fresh', 100);
    seedEmbedding('fresh', 100);
    seedSong('stale', 999);
    seedEmbedding('stale', 100);

    const out = loadEmbeddings(db, ['fresh', 'stale'], MODEL);
    expect([...out.keys()]).toEqual(['fresh']);
  });
});

describe('embeddingModelFor', () => {
  it('returns the stored model, or null when the seed has none', () => {
    seedSong('s1', 1000);
    seedEmbedding('s1', 1000);
    expect(embeddingModelFor(db, 's1')).toBe(MODEL);
    expect(embeddingModelFor(db, 'nope')).toBeNull();
  });
});
