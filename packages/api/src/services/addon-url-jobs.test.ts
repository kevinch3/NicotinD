import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { createJob } from './acquisition-job-store.js';
import {
  acquireStageFor,
  acquireStateFor,
  addonUrlJobUrl,
  findInFlightAddonUrlJob,
  getAddonUrlJob,
  listAddonUrlJobs,
} from './addon-url-jobs.js';

describe('acquireStateFor', () => {
  it('maps the unified job states onto the AcquireJob lifecycle', () => {
    expect(acquireStateFor('done', 'done')).toBe('done');
    expect(acquireStateFor('failed', 'error')).toBe('failed');
    // A superseded job is terminal too — reporting it 'queued' would leave the
    // link card spinning on a job nothing will ever advance.
    expect(acquireStateFor('superseded', 'done')).toBe('failed');
    expect(acquireStateFor('active', 'queued')).toBe('queued');
    expect(acquireStateFor('active', 'downloading')).toBe('running');
    expect(acquireStateFor('active', null)).toBe('queued');
  });
});

describe('acquireStageFor', () => {
  it('passes known stages through and nulls anything else', () => {
    expect(acquireStageFor('organizing')).toBe('organizing');
    expect(acquireStageFor('processing')).toBe('processing');
    expect(acquireStageFor('nonsense')).toBeNull();
    expect(acquireStageFor(null)).toBeNull();
  });
});

describe('addon URL job projection', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function addAddonUrlJob(url: string, id = crypto.randomUUID()): string {
    return createJob(db, {
      id,
      kind: 'url',
      method: 'ytdlp-addon',
      sourceRef: `addon:ytdlp-addon:${id}`,
      sourceUrl: url,
      files: [],
    });
  }

  it('finds an in-flight job by url and ignores terminal ones', () => {
    const id = addAddonUrlJob('https://youtu.be/a');
    expect(findInFlightAddonUrlJob(db, 'https://youtu.be/a')?.id).toBe(id);
    expect(findInFlightAddonUrlJob(db, 'https://youtu.be/other')).toBeNull();

    db.run(`UPDATE acquisition_jobs SET state = 'done' WHERE id = ?`, [id]);
    expect(findInFlightAddonUrlJob(db, 'https://youtu.be/a')).toBeNull();
  });

  it('never matches a non-addon url job (the watcher owns its own guard)', () => {
    const id = crypto.randomUUID();
    createJob(db, { id, kind: 'url', method: 'ytdlp', sourceRef: 'https://youtu.be/a' });
    expect(findInFlightAddonUrlJob(db, 'https://youtu.be/a')).toBeNull();
    expect(listAddonUrlJobs(db)).toHaveLength(0);
  });

  /**
   * A playlist is named by its playlist title, not by whatever album its tracks
   * happen to be filed under — so the display title outranks `album_title` on
   * the Acquire page's link card exactly as it does in the unified feed.
   */
  it("labels a job by the addon's display title, above the filing album", () => {
    const id = addAddonUrlJob('https://www.youtube.com/playlist?list=PL1');
    db.run(`UPDATE acquisition_jobs SET display_title = ?, album_title = ? WHERE id = ?`, [
      'Summer Mix 2024',
      'Some Album',
      id,
    ]);
    expect(listAddonUrlJobs(db)[0]!.label).toBe('Summer Mix 2024');
  });

  it('falls back to the filing album when no display title was supplied', () => {
    const id = addAddonUrlJob('https://open.spotify.com/album/y');
    db.run(`UPDATE acquisition_jobs SET album_title = ? WHERE id = ?`, ['Discovery', id]);
    expect(listAddonUrlJobs(db)[0]!.label).toBe('Discovery');
  });

  it('projects progress from the mirrored items and reports created_at in seconds', () => {
    const id = addAddonUrlJob('https://open.spotify.com/album/x');
    const now = Date.now();
    db.run(`UPDATE acquisition_jobs SET created_at = ? WHERE id = ?`, [now, id]);
    for (const [title, state] of [
      ['One', 'scanned'],
      ['Two', 'completed'],
      ['Three', 'downloading'],
    ] as const) {
      db.run(
        `INSERT INTO acquisition_job_items (job_id, track_title, state, updated_at)
         VALUES (?, ?, ?, ?)`,
        [id, title, state, now],
      );
    }
    const job = getAddonUrlJob(db, id)!;
    expect(job.progress).toEqual({ done: 2, total: 3 });
    expect(job.tracks.map((t) => t.status)).toEqual(['done', 'done', 'downloading']);
    // AcquireJob.created_at is unix seconds; acquisition_jobs stores millis.
    expect(job.created_at).toBe(Math.floor(now / 1000));
    expect(job.url).toBe('https://open.spotify.com/album/x');
  });

  it('resolves the destination album from landed songs so "Open in Library" works', () => {
    const id = addAddonUrlJob('https://youtu.be/b');
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, synced_at)
       VALUES ('alb1', 'Ídolo', 'C. Tangana', 'art1', 0)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at, album_artist, album_artist_id)
       VALUES ('song1', 'alb1', 'Tú Me Dejaste De Querer', 'C. Tangana', 'art1', 'a/b.mp3', 0, 'C. Tangana', 'art1')`,
    );
    db.run(
      `INSERT INTO acquisition_job_items (job_id, track_title, state, song_id, updated_at)
       VALUES (?, 'x', 'scanned', 'song1', 0)`,
      [id],
    );
    const job = getAddonUrlJob(db, id)!;
    expect(job.albumId).toBe('alb1');
    expect(job.destinationAlbums).toEqual([
      { albumId: 'alb1', albumArtist: 'C. Tangana', albumTitle: 'Ídolo' },
    ]);
  });

  it('lists newest first and exposes the stored url for retry', () => {
    const older = addAddonUrlJob('https://youtu.be/old');
    const newer = addAddonUrlJob('https://youtu.be/new');
    db.run(`UPDATE acquisition_jobs SET created_at = 1000 WHERE id = ?`, [older]);
    db.run(`UPDATE acquisition_jobs SET created_at = 2000 WHERE id = ?`, [newer]);
    expect(listAddonUrlJobs(db).map((j) => j.id)).toEqual([newer, older]);
    expect(addonUrlJobUrl(db, older)).toBe('https://youtu.be/old');
    expect(addonUrlJobUrl(db, 'nope')).toBeNull();
  });

  // Regression guard for issue #587: this projection's isPlaylist/playlistId
  // used to be hardcoded false/null with a comment saying playlist generation
  // was in-process-engine-only. It reads real values now — this row is only
  // ever the deduped-away twin of the AcquisitionJobView the card actually
  // renders (mergeAcquisitionJobs drops it), but a stale hardcode here would
  // still mislead the next reader.
  it('reads the real playlist classification and generated id, not a hardcoded default', () => {
    const id = addAddonUrlJob('https://open.spotify.com/playlist/abc');
    db.run(`UPDATE acquisition_jobs SET is_playlist = 1, playlist_id = 'pl-1' WHERE id = ?`, [id]);
    const job = listAddonUrlJobs(db)[0]!;
    expect(job.isPlaylist).toBe(true);
    expect(job.playlistId).toBe('pl-1');
  });
});
