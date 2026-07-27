import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  backfillDirectJobAlbum,
  createJob,
  getJob,
  jobAlbumPairs,
  jobCanonicalTracklists,
  jobMetaForTransfer,
  listJobFeed,
  markItemCompleted,
  markItemOrganized,
  markItemsScanned,
  markMissingItemsUnavailable,
  reconcileOnBoot,
  reconcileOrganizedItems,
  recomputeStage,
  repointItem,
  supersedeActiveJobs,
  transferKeyFor,
} from './acquisition-job-store.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('jobAlbumPairs / jobCanonicalTracklists (shared album_jobs ∪ acquisition_jobs readers)', () => {
  function insertAlbumJob(artist: string, album: string, state: string, canonical: string[]) {
    // album_jobs.canonical_tracks_json is NOT NULL, so an "excluded from canonical"
    // row uses an empty array (valid, but length-0 → skipped by the helper).
    db.run(
      `INSERT INTO album_jobs
         (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json,
          created_at, artist_name, album_title, state)
       VALUES (1, 'peer', 'dir', ?, '[]', 0, ?, ?, ?)`,
      [JSON.stringify(canonical), artist, album, state],
    );
  }

  it('unions both tables and filters to active jobs on request', () => {
    // acquisition_jobs row (active) via the store.
    createJob(db, {
      kind: 'track-search',
      method: 'slskd',
      artistName: 'David Bowie',
      albumTitle: 'Heathen',
      canonicalTracks: ['Sunday', 'Slip Away'],
      username: 'peer1',
      files: [{ filename: 'x\\01 Sunday.flac', size: 1, trackTitle: 'Sunday' }],
    });
    insertAlbumJob('Radiohead', 'Kid A', 'active', ['Everything', 'Idioteque']);
    insertAlbumJob('Muse', 'Drones', 'done', []); // done + empty canonical

    const all = jobAlbumPairs(db)
      .map((p) => `${p.artistName} — ${p.albumTitle}`)
      .sort();
    expect(all).toEqual(['David Bowie — Heathen', 'Muse — Drones', 'Radiohead — Kid A']);

    const active = jobAlbumPairs(db, { activeOnly: true })
      .map((p) => p.albumTitle)
      .sort();
    expect(active).toEqual(['Heathen', 'Kid A']); // Drones (done) excluded

    const canon = jobCanonicalTracklists(db)
      .map((r) => `${r.albumTitle}:${r.canonicalTracks.length}`)
      .sort();
    expect(canon).toEqual(['Heathen:2', 'Kid A:2']); // Drones (null canonical) excluded
  });

  it('degrades to empty on a schema-less DB (missing tables)', () => {
    const bare = new Database(':memory:');
    expect(jobAlbumPairs(bare)).toEqual([]);
    expect(jobCanonicalTracklists(bare)).toEqual([]);
  });
});

describe('createJob', () => {
  it('inserts a job with its items and returns the job id', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'David Bowie',
      albumTitle: 'Heathen',
      lidarrAlbumId: 42,
      genres: ['Rock', 'Art Rock'],
      year: 2002,
      canonicalTracks: ['Sunday', 'Slip Away'],
      sourceRef: 'peer1',
      username: 'peer1',
      files: [
        { filename: '@@abc\\Music\\Heathen\\01 Sunday.flac', size: 1, trackTitle: 'Sunday' },
        { filename: '@@abc\\Music\\Heathen\\02 Slip Away.flac', size: 2, trackTitle: 'Slip Away' },
      ],
    });
    expect(id).toBeTruthy();
    const job = getJob(db, id);
    expect(job?.artistName).toBe('David Bowie');
    expect(job?.albumTitle).toBe('Heathen');
    expect(job?.state).toBe('active');
    expect(job?.stage).toBe('downloading');
    expect(job?.genres).toEqual(['Rock', 'Art Rock']);
    expect(job?.year).toBe(2002);
    expect(job?.items).toHaveLength(2);
  });

  it('auto-matches item track titles from the canonical tracklist when not given', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      canonicalTracks: ['Sunday', 'Slip Away', '5:15 The Angels Have Gone'],
      files: [
        { filename: '@@x\\Heathen\\02 Slip Away.flac' },
        { filename: '@@x\\Heathen\\99 Unrelated Bonus.flac' },
      ],
    });
    const items = getJob(db, id)!.items;
    expect(items[0].trackTitle).toBe('Slip Away');
    expect(items[1].trackTitle).toBeNull();
  });

  it('stores the exact transfer key — backslashes and case preserved, never normalized', () => {
    const filename = '@@Xy\\MUSIC\\Album (2002)\\01 - Träck.FLAC';
    createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'PeerCase',
      files: [{ filename, size: 1 }],
    });
    const row = db
      .query<{ transfer_key: string }, []>(`SELECT transfer_key FROM acquisition_job_items`)
      .get();
    expect(row?.transfer_key).toBe(`PeerCase::${filename}`);
    expect(row?.transfer_key).toBe(transferKeyFor('PeerCase', filename));
  });

  it('persists per-file bitRate + audioFormat and surfaces them on getJob', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      canonicalTracks: ['A', 'B'],
      files: [
        {
          filename: '@@p\\Album\\A.flac',
          size: 1,
          trackTitle: 'A',
          bitRate: 1411,
          audioFormat: 'FLAC',
        },
        {
          filename: '@@p\\Album\\B.mp3',
          size: 2,
          trackTitle: 'B',
          bitRate: 320,
          audioFormat: 'MP3',
        },
      ],
    });
    const items = getJob(db, id)!.items;
    expect(items[0]?.bitRate).toBe(1411);
    expect(items[0]?.audioFormat).toBe('FLAC');
    expect(items[1]?.bitRate).toBe(320);
    expect(items[1]?.audioFormat).toBe('MP3');
  });

  it('null bitRate / audioFormat are stored as null (not 0 / empty string)', () => {
    const id = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'peer1',
      files: [{ filename: '@@p\\Album\\A.flac', size: 1 }],
    });
    const item = getJob(db, id)!.items[0]!;
    expect(item.bitRate).toBeNull();
    expect(item.audioFormat).toBeNull();
  });
});

describe('jobMetaForTransfer', () => {
  it('resolves job metadata by exact (username, filename)', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'peer1',
      canonicalTracks: ['Sunday'],
      files: [{ filename: 'a\\b\\01.flac', size: 1, trackTitle: 'Sunday' }],
    });
    const meta = jobMetaForTransfer(db, 'peer1', 'a\\b\\01.flac');
    expect(meta?.jobId).toBe(id);
    expect(meta?.artistName).toBe('Bowie');
    expect(meta?.albumTitle).toBe('Heathen');
    expect(meta?.canonicalTracks).toEqual(['Sunday']);
  });

  it('returns null for an unknown transfer', () => {
    expect(jobMetaForTransfer(db, 'peer1', 'nope.flac')).toBeNull();
  });
});

/** Create a two-track slskd job for lifecycle tests. */
function seedJob(overrides: { lidarrAlbumId?: number } = {}): string {
  return createJob(db, {
    kind: 'album-hunt',
    method: 'slskd',
    artistName: 'Bowie',
    albumTitle: 'Heathen',
    lidarrAlbumId: overrides.lidarrAlbumId ?? null,
    username: 'peer1',
    canonicalTracks: ['Sunday', 'Slip Away'],
    files: [
      { filename: 'a\\01 Sunday.flac', trackTitle: 'Sunday' },
      { filename: 'a\\02 Slip Away.flac', trackTitle: 'Slip Away' },
    ],
  });
}

function itemStates(id: string): string[] {
  return (getJob(db, id)?.items ?? []).map((i) => i.state);
}

/** Insert a landed (or quarantined) library song so scanned items can resolve. */
function seedSong(songId: string, path: string, landed: boolean): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Heathen', 'Bowie', 'art', 2, 0, 1)`,
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, landed_at, synced_at)
     VALUES (?, 'al', ?, 'Bowie', 'art', 0, ?, 10, '2024-01-01', ?, 1)`,
    [songId, songId, path, landed ? 1 : null],
  );
}

describe('item lifecycle', () => {
  it('marks completion, organization and scan on the same item row', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    expect(itemStates(id)).toEqual(['completed', 'downloading']);

    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');
    const afterOrganize = getJob(db, id)!.items[0];
    expect(afterOrganize.state).toBe('organized');
    expect(afterOrganize.relativePath).toBe('Bowie/Heathen/01.opus');

    markItemsScanned(db, new Map([['Bowie/Heathen/01.opus', 's1']]));
    const afterScan = getJob(db, id)!.items[0];
    expect(afterScan.state).toBe('scanned');
    expect(afterScan.songId).toBe('s1');
  });

  it('scans an item whose organized path differs only in casing (#262)', () => {
    // The organizer records the path it wrote; the scanner mints
    // library_songs.path from tags. Prod stranded items on that difference.
    const id = seedJob();
    markItemOrganized(
      db,
      transferKeyFor('peer1', 'a\\01 Sunday.flac'),
      'Bowie/Heathen/01 - quien te dijo eso.opus',
    );

    markItemsScanned(db, new Map([['Bowie/Heathen/01 - Quien Te Dijo Eso.opus', 's1']]));

    expect(getJob(db, id)!.items[0].state).toBe('scanned');
  });
});

/**
 * Issue #262: jobs stranded at `state=active, stage=scanning` with items frozen
 * at `organized`. `markItemsScanned` only sees the paths of the scan batch that
 * just ran, so an item organized by any other batch is never revisited.
 */
describe('reconcileOrganizedItems (#262)', () => {
  it('rescues an organized item whose song is already in the library', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');
    // The song landed via a different scan batch — nothing links it back.
    seedSong('s1', 'Bowie/Heathen/01.opus', true);
    expect(getJob(db, id)!.items[0].state).toBe('organized');

    expect(reconcileOrganizedItems(db)).toBe(1);

    const item = getJob(db, id)!.items[0];
    expect(item.state).toBe('scanned');
    expect(item.songId).toBe('s1');
  });

  /**
   * SQLite's `COLLATE NOCASE` folds ASCII case ONLY, never diacritics. Measured
   * on prod: a job sat at `scanning` for 23 h with four organized items whose
   * files had been present the whole time — the organizer had recorded
   * `Los Autenticos Decadentes/…` while the library held
   * `Los Auténticos Decadentes/…`.
   */
  it('rescues an item whose recorded path differs only by accents', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(
      db,
      transferKeyFor('peer1', 'a\\01 Sunday.flac'),
      'Los Autenticos Decadentes/Hoy trasnoche/01 - Yo Puedo.mp3',
    );
    seedSong('s1', 'Los Auténticos Decadentes/Hoy trasnoche/01 - Yo Puedo.mp3', true);

    expect(reconcileOrganizedItems(db)).toBe(1);
    const item = getJob(db, id)!.items[0];
    expect(item.state).toBe('scanned');
    expect(item.songId).toBe('s1');
  });

  it('still matches on ASCII case alone, without needing the fold', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01 SUNDAY.opus');
    seedSong('s1', 'Bowie/Heathen/01 sunday.opus', true);

    expect(reconcileOrganizedItems(db)).toBe(1);
    expect(getJob(db, id)!.items[0].songId).toBe('s1');
  });

  /**
   * The other prod job was genuinely partial — two `.opus` tracks that never
   * landed under any spelling. Folding must not invent a match for those; the
   * 24 h idle valve is what closes them.
   */
  it('leaves an item alone when no song matches under any folding', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Fonsi/Abrazar/12 - Se Supone.opus');
    seedSong('s1', 'Someone Else/Other/01 - Different.opus', true);

    expect(reconcileOrganizedItems(db)).toBe(0);
    expect(getJob(db, id)!.items[0].state).toBe('organized');
  });

  it('closes the job once the last organized item is rescued', () => {
    const id = seedJob();
    for (const f of ['a\\01 Sunday.flac', 'a\\02 Slip Away.flac']) {
      markItemCompleted(db, transferKeyFor('peer1', f));
    }
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');
    markItemOrganized(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'), 'Bowie/Heathen/02.opus');
    seedSong('s1', 'Bowie/Heathen/01.opus', true);
    seedSong('s2', 'Bowie/Heathen/02.opus', true);
    recomputeStage(db, id);
    expect(getJob(db, id)!.stage).toBe('scanning');

    reconcileOrganizedItems(db);

    const job = getJob(db, id)!;
    expect(job.state).toBe('done');
    expect(job.stage).toBe('done');
  });

  it('leaves an organized item with no library row alone', () => {
    // A duplicate copy deduped away at ingest never gets a song row; the 24h
    // idle valve — not this — is what eventually closes it out.
    const id = seedJob();
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');

    expect(reconcileOrganizedItems(db)).toBe(0);
    expect(getJob(db, id)!.items[0].state).toBe('organized');
  });

  it('runs as part of the boot/hygiene pass', () => {
    const id = seedJob();
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');
    markItemOrganized(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'), 'Bowie/Heathen/02.opus');
    seedSong('s1', 'Bowie/Heathen/01.opus', true);
    seedSong('s2', 'Bowie/Heathen/02.opus', true);

    reconcileOnBoot(db);

    expect(itemStates(id)).toEqual(['scanned', 'scanned']);
    expect(getJob(db, id)!.state).toBe('done');
  });
});

describe('listJobFeed sources (#261)', () => {
  it('groups items by peer so one job can render one card with N sources', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Luis Fonsi',
      albumTitle: 'Abrazar la vida',
      canonicalTracks: ['One', 'Two', 'Three'],
      files: [
        { filename: 'a\\01.flac', trackTitle: 'One', username: 'smuks' },
        { filename: 'a\\02.flac', trackTitle: 'Two', username: 'smuks' },
        { filename: 'b\\03.flac', trackTitle: 'Three', username: 'dolche' },
      ],
    });

    const job = listJobFeed(db).find((j) => j.id === id)!;
    expect(job.sources).toEqual([
      { username: 'smuks', fileCount: 2, state: 'downloading' },
      { username: 'dolche', fileCount: 1, state: 'downloading' },
    ]);
  });

  it('reports a peer worst-state-first so a partial failure is visible', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer',
      canonicalTracks: ['One', 'Two'],
      files: [
        { filename: 'a\\01.flac', trackTitle: 'One' },
        { filename: 'a\\02.flac', trackTitle: 'Two' },
      ],
    });
    db.run(
      `UPDATE acquisition_job_items SET state = 'failed' WHERE job_id = ? AND track_title = 'Two'`,
      [id],
    );

    const job = listJobFeed(db).find((j) => j.id === id)!;
    expect(job.sources[0]).toEqual({ username: 'peer', fileCount: 2, state: 'failed' });
  });
});

describe('listJobFeed', () => {
  it('maps every acquisition_job_items state onto the shared TrackStatus union', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'peer1',
      files: [
        { filename: 'a\\01.flac', trackTitle: 'Downloading Track' },
        { filename: 'a\\02.flac', trackTitle: 'Completed Track' },
        { filename: 'a\\03.flac', trackTitle: 'Organized Track' },
        { filename: 'a\\04.flac', trackTitle: 'Scanned Track' },
        { filename: 'a\\05.flac', trackTitle: 'Failed Track' },
        { filename: 'a\\06.flac', trackTitle: 'Unavailable Track' },
      ],
    });
    // 'downloading' is already the state createJob leaves items in; drive the
    // rest directly via SQL — these states are otherwise only reachable
    // through multi-step lifecycle calls this test doesn't need.
    db.run(`UPDATE acquisition_job_items SET state = 'completed' WHERE track_title = ?`, [
      'Completed Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'organized' WHERE track_title = ?`, [
      'Organized Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'scanned' WHERE track_title = ?`, [
      'Scanned Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'failed' WHERE track_title = ?`, [
      'Failed Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'unavailable' WHERE track_title = ?`, [
      'Unavailable Track',
    ]);

    const feed = listJobFeed(db);
    const job = feed.find((j) => j.id === id);
    expect(job).toBeDefined();
    const items = job!.items;
    expect(items).toHaveLength(6);
    expect(items.find((i) => i.title === 'Downloading Track')?.status).toBe('downloading');
    expect(items.find((i) => i.title === 'Completed Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Organized Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Scanned Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Failed Track')?.status).toBe('failed');
    expect(items.find((i) => i.title === 'Unavailable Track')?.status).toBe('skipped');
  });

  it('falls back to pending for an unrecognized/legacy state value', () => {
    const id = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'peer1',
      files: [{ filename: 'a\\01.flac', trackTitle: 'Mystery Track' }],
    });
    db.run(`UPDATE acquisition_job_items SET state = 'queued' WHERE track_title = ?`, [
      'Mystery Track',
    ]);
    const job = listJobFeed(db).find((j) => j.id === id);
    expect(job!.items[0].status).toBe('pending');
  });

  it('rolls up the dominant bitrate across items (mode wins; ties → max kbps)', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      files: [
        { filename: 'a\\01.flac', trackTitle: 'A', bitRate: 320, audioFormat: 'MP3' },
        { filename: 'a\\02.flac', trackTitle: 'B', bitRate: 320, audioFormat: 'MP3' },
        { filename: 'a\\03.flac', trackTitle: 'C', bitRate: 256, audioFormat: 'MP3' },
      ],
    });
    const job = listJobFeed(db).find((j) => j.id === id);
    expect(job!.bitRate).toBe(320);
    expect(job!.audioFormat).toBe('MP3');
  });

  it('upgrades the rollup to library_songs.bit_rate when the item has a relative_path', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      files: [
        // Enqueue-time bitrate (peer's MP3); relative_path connects it to the
        // scanned library row.
        { filename: 'a\\01.flac', trackTitle: 'A', bitRate: 320, audioFormat: 'MP3' },
      ],
    });
    db.run(
      `UPDATE acquisition_job_items SET relative_path = ?, state = 'scanned' WHERE track_title = 'A'`,
      ['Bowie/Heathen/01.flac'],
    );
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('alb1', 'Heathen', 'Bowie', 'art', 1, 0, 1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, artist_id, path, artist, title, duration, bit_rate, suffix, synced_at, created, landed_at)
       VALUES ('song1', 'alb1', 'art', 'Bowie/Heathen/01.flac', 'Bowie', 'A', 200, 192, 'opus', 1, 1, 1)`,
    );
    const job = listJobFeed(db).find((j) => j.id === id);
    // Scanned (library) value wins over enqueue-time value — the lossless→opus
    // case: 320 kbps MP3 peer → 192 kbps Opus in the library.
    expect(job!.bitRate).toBe(192);
  });

  it('reports bitRate undefined when no item has a quality signature', () => {
    const id = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'peer1',
      // No bitRate on any file — legacy direct enqueue.
      files: [{ filename: 'a\\01.flac', trackTitle: 'A' }],
    });
    const job = listJobFeed(db).find((j) => j.id === id);
    expect(job!.bitRate).toBeUndefined();
    expect(job!.audioFormat).toBeUndefined();
  });
});

describe('repointItem', () => {
  it('re-points the matching non-completed item to a new peer, bumping attempts', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));

    const ok = repointItem(db, id, 'Slip Away', 'peer2', 'x\\Slip Away.mp3');
    expect(ok).toBe(true);
    const item = getJob(db, id)!.items[1];
    expect(item.username).toBe('peer2');
    expect(item.transferKey).toBe(transferKeyFor('peer2', 'x\\Slip Away.mp3'));
    expect(item.attempts).toBe(2);
    expect(item.state).toBe('downloading');
  });

  it('never re-points a completed item', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    const ok = repointItem(db, id, 'Sunday', 'peer2', 'x\\Sunday.mp3');
    expect(ok).toBe(false);
    expect(getJob(db, id)!.items[0].username).toBe('peer1');
  });

  it('upgrades bit_rate_kbps + audio_format when the alternate peer offers a known quality', () => {
    const id = seedJob();
    const ok = repointItem(db, id, 'Sunday', 'peer2', 'x\\Sunday.flac', 1411, 'FLAC');
    expect(ok).toBe(true);
    const item = getJob(db, id)!.items.find((i) => i.trackTitle === 'Sunday')!;
    expect(item.bitRate).toBe(1411);
    expect(item.audioFormat).toBe('FLAC');
  });

  it('preserves the original bitRate when the repoint carries none (partial fallback info)', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      canonicalTracks: ['Sunday'],
      files: [
        { filename: 'a\\01 Sunday.flac', trackTitle: 'Sunday', bitRate: 320, audioFormat: 'MP3' },
      ],
    });
    // No bitRate passed — the alternate is unknown quality; the existing
    // 320 kbps MP3 stays so the card doesn't downgrade to "no info".
    repointItem(db, id, 'Sunday', 'peer2', 'x\\Sunday.flac');
    const item = getJob(db, id)!.items[0]!;
    expect(item.bitRate).toBe(320);
    expect(item.audioFormat).toBe('MP3');
  });
});

describe('recomputeStage', () => {
  it('walks downloading → organizing → scanning → processing → done', () => {
    const id = seedJob();
    expect(recomputeStage(db, id)).toBe('downloading');

    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemCompleted(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'));
    expect(recomputeStage(db, id)).toBe('organizing');

    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'p/01.opus');
    markItemOrganized(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'), 'p/02.opus');
    expect(recomputeStage(db, id)).toBe('scanning');

    seedSong('s1', 'p/01.opus', false);
    seedSong('s2', 'p/02.opus', false);
    markItemsScanned(
      db,
      new Map([
        ['p/01.opus', 's1'],
        ['p/02.opus', 's2'],
      ]),
    );
    expect(recomputeStage(db, id)).toBe('processing');

    db.run(`UPDATE library_songs SET landed_at = 2`);
    expect(recomputeStage(db, id)).toBe('done');
    expect(getJob(db, id)?.state).toBe('done');
  });

  it('closes a job as partial done when remaining items are unavailable — never waits 13 of 13', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'p/01.opus');
    seedSong('s1', 'p/01.opus', true);
    markItemsScanned(db, new Map([['p/01.opus', 's1']]));

    markMissingItemsUnavailable(db, id);
    expect(recomputeStage(db, id)).toBe('done');
    const job = getJob(db, id)!;
    expect(job.state).toBe('done');
    expect(job.items.map((i) => i.state).sort()).toEqual(['scanned', 'unavailable']);
  });

  it('fails the job when every item is failed or unavailable', () => {
    const id = seedJob();
    markMissingItemsUnavailable(db, id);
    expect(recomputeStage(db, id)).toBe('error');
    expect(getJob(db, id)?.state).toBe('failed');
  });
});

describe('supersedeActiveJobs', () => {
  it('supersedes active jobs for the same Lidarr album', () => {
    const oldId = seedJob({ lidarrAlbumId: 42 });
    supersedeActiveJobs(db, { lidarrAlbumId: 42 });
    expect(getJob(db, oldId)?.state).toBe('superseded');
  });
});

describe('reconcileOnBoot', () => {
  it('closes out jobs whose non-terminal items have been idle past the valve', () => {
    const id = seedJob();
    db.run(`UPDATE acquisition_job_items SET updated_at = 1`); // ancient
    db.run(`UPDATE acquisition_jobs SET created_at = 1, updated_at = 1`);
    reconcileOnBoot(db);
    const job = getJob(db, id)!;
    expect(job.items.every((i) => i.state === 'failed')).toBe(true);
    expect(job.state).toBe('failed');
  });

  it('leaves fresh active jobs alone and prunes old finished jobs', () => {
    const fresh = seedJob();
    const old = seedJob();
    db.run(
      `UPDATE acquisition_jobs SET state = 'done', created_at = 1, updated_at = 1 WHERE id = ?`,
      [old],
    );
    reconcileOnBoot(db);
    expect(getJob(db, fresh)?.state).toBe('active');
    expect(getJob(db, old)).toBeNull();
    // Items cascade with the job
    const orphans = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) c FROM acquisition_job_items WHERE job_id = ?`,
      )
      .get(old);
    expect(orphans?.c).toBe(0);
  });
});

describe('backfillDirectJobAlbum (issue #223 — direct grab lands with a real "where")', () => {
  // Seed a canonical album + song into the library tables and return the
  // relative path + song id the scanner would have minted.
  function seedLandedSong(artist: string, album: string, title: string, relPath: string): string {
    const albumId = albumIdFor(artist, album);
    const songId = albumIdFor(relPath, title); // any stable id, uniqueness only
    db.run(
      `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, synced_at)
       VALUES (?, ?, ?, ?, 0)`,
      [albumId, album, artist, artistIdFor(artist)],
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [songId, albumId, title, artist, artistIdFor(artist), relPath],
    );
    return songId;
  }

  it('re-points a direct job to the album its file actually landed in', () => {
    // A raw peer grab whose enqueue-time hints are a noisy folder segment.
    const jobId = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      artistName: 'peer-share-2020', // wrong / raw folder segment
      albumTitle: 'FLAC rips',
      username: 'peer1',
      files: [{ filename: 'peer-share-2020\\FLAC rips\\01 Sunday.flac', size: 1 }],
    });
    const relPath = 'David Bowie/Heathen/01 Sunday.flac';
    const songId = seedLandedSong('David Bowie', 'Heathen', 'Sunday', relPath);
    // Simulate the watcher's organize→scan seam.
    markItemOrganized(db, transferKeyFor('peer1', 'peer-share-2020\\FLAC rips\\01 Sunday.flac'), relPath);
    markItemsScanned(db, new Map([[relPath, songId]]));

    backfillDirectJobAlbum(db, jobId);

    const job = getJob(db, jobId)!;
    expect(job.artistName).toBe('David Bowie');
    expect(job.albumTitle).toBe('Heathen');
    // The feed's deep-link albumId now resolves to the real album.
    expect(albumIdFor(job.artistName!, job.albumTitle!)).toBe(albumIdFor('David Bowie', 'Heathen'));
  });

  it('never overwrites an album-hunt job (authoritative canonical metadata)', () => {
    const jobId = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Radiohead',
      albumTitle: 'Kid A',
      username: 'peer1',
      files: [{ filename: 'x\\01 Everything.flac', size: 1 }],
    });
    const relPath = 'Wrong Artist/Wrong Album/01 Everything.flac';
    const songId = seedLandedSong('Wrong Artist', 'Wrong Album', 'Everything', relPath);
    markItemOrganized(db, transferKeyFor('peer1', 'x\\01 Everything.flac'), relPath);
    markItemsScanned(db, new Map([[relPath, songId]]));

    backfillDirectJobAlbum(db, jobId);

    const job = getJob(db, jobId)!;
    expect(job.artistName).toBe('Radiohead'); // unchanged
    expect(job.albumTitle).toBe('Kid A');
  });

  it('is a no-op when the direct job has no scanned items yet', () => {
    const jobId = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      artistName: 'raw',
      albumTitle: 'folder',
      username: 'peer1',
      files: [{ filename: 'raw\\folder\\01 x.flac', size: 1 }],
    });
    backfillDirectJobAlbum(db, jobId);
    const job = getJob(db, jobId)!;
    expect(job.artistName).toBe('raw'); // untouched — nothing landed
  });
});
