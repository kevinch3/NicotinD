import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { albumFolderOf, requestBetterCopy } from './song-improve.js';
import type { TrackGetRequest } from './track-get.service.js';

describe('albumFolderOf', () => {
  it('reads the <Artist>/<Album> folder a file sits in', () => {
    expect(albumFolderOf('Natiruts/Box Natiruts/01 - Glamour Tropical.opus')).toEqual({
      artist: 'Natiruts',
      album: 'Box Natiruts',
    });
  });

  it('is null for a loose single and for a layout the organizer does not make', () => {
    expect(albumFolderOf('Natiruts/Singles/Glamour Tropical.opus')).toBeNull();
    expect(albumFolderOf('loose.mp3')).toBeNull();
    expect(albumFolderOf('Artist/Album/CD1/01.mp3')).toBeNull();
  });
});

describe('requestBetterCopy', () => {
  let db: Database;
  const requests: TrackGetRequest[] = [];
  const deps = () => ({
    db,
    isAcquisitionEnabled: () => true,
    requestTrackGet: (req: TrackGetRequest) => {
      requests.push(req);
      return { status: 'accepted' as const, jobId: `job-${requests.length}` };
    },
  });
  const actor = { actor: { sub: 'u1', username: 'kev' } };

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    requests.length = 0;
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES ('s1', 'al', 'Track', 'Various Artists Comp Act', 'act', 60, 'Various Artists/Comp/01 - Track.mp3', 1)`,
    );
  });

  it("hunts a compilation folder's song by its own credit", () => {
    requestBetterCopy(deps(), 's1', actor);
    expect(requests[0]).toMatchObject({ artist: 'Various Artists Comp Act', album: 'Comp' });
  });

  it('starts again once the earlier Get for the song was cancelled', () => {
    db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, artist_name, album_title, display_title, cancel_requested_at, created_at, updated_at)
       VALUES ('old', 'track-search', 'a', 'active', 'resolving', 'Various Artists Comp Act', 'Comp', 'Track', 5, 1, 1)`,
    );
    expect(requestBetterCopy(deps(), 's1', actor)).toEqual({
      ok: true,
      outcome: 'started',
      jobId: 'job-1',
    });
  });
});
