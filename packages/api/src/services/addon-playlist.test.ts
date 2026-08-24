import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { createJob } from './acquisition-job-store.js';
import { PlaylistService } from './playlist.service.js';
import { materializeAddonPlaylist } from './addon-playlist.js';

let db: Database;
let playlists: PlaylistService;

beforeEach(() => {
  db = new Database(':memory:');
  db.run('PRAGMA foreign_keys=ON');
  applySchema(db);
  playlists = new PlaylistService(db);
  db.run(
    `INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'x'), ('u2', 'b', 'y')`,
  );
  for (const id of ['s1', 's2', 's3']) {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 60, ?, 1)`,
      [id, id.toUpperCase(), `p/${id}.mp3`],
    );
  }
});

/** A playlist-classified url job with `n` items, in playlist order, item `i` landing as `songId[i]`. */
function seedPlaylistJob(opts: {
  userId?: string | null;
  isPlaylist?: boolean;
  displayTitle?: string | null;
  sourceUrl?: string;
  songIds: (string | null)[]; // null = never landed (failed/unavailable)
}): string {
  const id = createJob(db, {
    kind: 'url',
    method: 'spotdl-addon',
    displayTitle: opts.displayTitle ?? 'My Playlist',
    sourceUrl: opts.sourceUrl ?? 'https://open.spotify.com/playlist/abc',
    userId: opts.userId ?? 'u1',
    isPlaylist: opts.isPlaylist ?? true,
    stage: 'queued',
  });
  for (const [i, songId] of opts.songIds.entries()) {
    db.run(
      `INSERT INTO acquisition_job_items (job_id, track_title, state, song_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, `Track ${i}`, songId ? 'scanned' : 'unavailable', songId, Date.now()],
    );
  }
  return id;
}

describe('materializeAddonPlaylist', () => {
  it('creates a native playlist from the landed items, in item order', () => {
    const jobId = seedPlaylistJob({ songIds: ['s1', 's2', 's3'] });

    materializeAddonPlaylist(db, playlists, jobId);

    const row = db
      .query<{ playlist_id: string | null }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!;
    expect(row.playlist_id).toBeTruthy();
    const detail = playlists.get('u1', row.playlist_id!);
    expect(detail?.name).toBe('My Playlist');
    expect(detail?.songs.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('excludes tracks that never landed a song id', () => {
    const jobId = seedPlaylistJob({ songIds: ['s1', null, 's2'] });

    materializeAddonPlaylist(db, playlists, jobId);

    const row = db
      .query<{ playlist_id: string }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!;
    expect(playlists.get('u1', row.playlist_id)?.songs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('does nothing for a job the addon never classified as a playlist', () => {
    const jobId = seedPlaylistJob({ isPlaylist: false, songIds: ['s1'] });

    materializeAddonPlaylist(db, playlists, jobId);

    const row = db
      .query<{ playlist_id: string | null }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!;
    expect(row.playlist_id).toBeNull();
  });

  it('does nothing when no track landed — never creates an empty playlist', () => {
    const jobId = seedPlaylistJob({ songIds: [null, null] });

    materializeAddonPlaylist(db, playlists, jobId);

    const row = db
      .query<{ playlist_id: string | null }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!;
    expect(row.playlist_id).toBeNull();
  });

  it('re-firing on the same row refreshes the same playlist, never creates a second one', () => {
    const jobId = seedPlaylistJob({ songIds: ['s1', null] });
    materializeAddonPlaylist(db, playlists, jobId);
    const firstId = db
      .query<{ playlist_id: string }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!.playlist_id;

    // A second landed track arrives before the addon job is finally released
    // (applyAddonOutcome can fire more than once while closed but un-released).
    db.run(
      `UPDATE acquisition_job_items SET song_id = 's2', state = 'scanned'
       WHERE job_id = ? AND track_title = 'Track 1'`,
      [jobId],
    );
    materializeAddonPlaylist(db, playlists, jobId);

    const secondId = db
      .query<{ playlist_id: string }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(jobId)!.playlist_id;
    expect(secondId).toBe(firstId);
    expect(playlists.list('u1')).toHaveLength(1);
    expect(playlists.get('u1', firstId)?.songs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('a same-user retry (new job row, same URL) refreshes the prior playlist in place', () => {
    const url = 'https://open.spotify.com/playlist/xyz';
    const firstJob = seedPlaylistJob({ sourceUrl: url, songIds: ['s1'] });
    materializeAddonPlaylist(db, playlists, firstJob);

    // Retry mints a brand-new acquisition_jobs row for the same URL/user.
    const retryJob = seedPlaylistJob({ sourceUrl: url, songIds: ['s1', 's2'] });
    materializeAddonPlaylist(db, playlists, retryJob);

    expect(playlists.list('u1')).toHaveLength(1);
    const retryRow = db
      .query<{ playlist_id: string }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(retryJob)!;
    expect(playlists.get('u1', retryRow.playlist_id)?.songs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('a different user submitting the same URL gets their own playlist', () => {
    const url = 'https://open.spotify.com/playlist/xyz';
    const job1 = seedPlaylistJob({ sourceUrl: url, userId: 'u1', songIds: ['s1'] });
    materializeAddonPlaylist(db, playlists, job1);
    const job2 = seedPlaylistJob({ sourceUrl: url, userId: 'u2', songIds: ['s1'] });
    materializeAddonPlaylist(db, playlists, job2);

    expect(playlists.list('u1')).toHaveLength(1);
    expect(playlists.list('u2')).toHaveLength(1);
    expect(playlists.list('u1')[0]!.id).not.toBe(playlists.list('u2')[0]!.id);
  });

  it('creates a fresh playlist when the prior one was deleted by the user', () => {
    const url = 'https://open.spotify.com/playlist/xyz';
    const firstJob = seedPlaylistJob({ sourceUrl: url, songIds: ['s1'] });
    materializeAddonPlaylist(db, playlists, firstJob);
    const firstRow = db
      .query<{ playlist_id: string }, [string]>(
        `SELECT playlist_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(firstJob)!;
    expect(playlists.remove('u1', firstRow.playlist_id)).toBe(true);

    const retryJob = seedPlaylistJob({ sourceUrl: url, songIds: ['s2'] });
    materializeAddonPlaylist(db, playlists, retryJob);

    expect(playlists.list('u1')).toHaveLength(1);
  });
});
