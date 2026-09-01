import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  auditLibrary,
  summarize,
  checkMisSplitAlbums,
  checkRenderGaps,
  selectPollutionTargets,
  DELETABLE_RULES,
} from './library-audit.js';

function addArtist(db: Database, id: string, name: string, albumCount = 0): void {
  db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`, [
    id,
    name,
    albumCount,
  ]);
}

function addAlbum(
  db: Database,
  o: {
    id: string;
    name: string;
    artist: string;
    artistId: string;
    songCount?: number;
    classification?: string;
    hidden?: number;
    year?: number | null;
    cover?: string | null;
  },
): void {
  db.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, classification, hidden, year, cover_art, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      o.id,
      o.name,
      o.artist,
      o.artistId,
      o.songCount ?? 1,
      o.classification ?? 'single',
      o.hidden ?? 0,
      ('year' in o ? o.year : 2000) ?? null,
      ('cover' in o ? o.cover : 'x') ?? null,
    ],
  );
}

function addSong(db: Database, id: string, albumId: string, artistId: string, title = 't'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
     VALUES (?, ?, ?, 'a', ?, ?, 1)`,
    [id, albumId, title, artistId, `/m/${id}.opus`],
  );
}

/** A clean, finding-free library: one real artist, one real album, matching counts. */
function seedClean(db: Database): void {
  addArtist(db, 'ar1', 'Soda Stereo', 1);
  addAlbum(db, {
    id: 'al1',
    name: 'Dynamo',
    artist: 'Soda Stereo',
    artistId: 'ar1',
    songCount: 2,
    classification: 'album',
    year: 1992,
  });
  addSong(db, 's1', 'al1', 'ar1');
  addSong(db, 's2', 'al1', 'ar1');
  // Mirror library_artwork so render checks pass.
  db.run(
    `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('al1','album','u',1)`,
  );
}

describe('auditLibrary', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('reports no findings on a clean library', () => {
    seedClean(db);
    const report = auditLibrary(db);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.totals).toMatchObject({ artists: 1, albums: 1, songs: 2, visibleSingles: 0 });
  });

  it('flags a watermark artist (ftpdjemilio.com)', () => {
    addArtist(db, 'arw', 'ftpdjemilio.com', 1);
    addAlbum(db, { id: 'alw', name: 'Some Track', artist: 'ftpdjemilio.com', artistId: 'arw' });
    addSong(db, 'sw', 'alw', 'arw');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('watermark_artist');
    expect(auditLibrary(db).ok).toBe(false);
  });

  it('flags a DJ-set artist line and names the merge target (issue #679)', () => {
    addArtist(db, 'ard', 'Enrico Sangiuliano @ Awakenings', 1);
    addAlbum(db, {
      id: 'ald',
      name: 'Biomorph',
      artist: 'Enrico Sangiuliano @ Awakenings',
      artistId: 'ard',
    });
    addSong(db, 'sd', 'ald', 'ard');
    const finding = auditLibrary(db).findings.find((f) => f.rule === 'djset_artist');
    expect(finding?.subject).toBe('ard');
    expect(finding?.message).toContain('merge into "Enrico Sangiuliano"');
  });

  it('flags an artist shredded into per-track credit rows, against the base (issue #864)', () => {
    addArtist(db, 'arbase', 'Sanampay', 1);
    for (const [id, name] of [
      ['arf1', 'Sanampay, V. PARRA'],
      ['arf2', 'Sanampay, CH. BUARQUE'],
      ['arf3', 'Sanampay, D.P.'],
    ] as const) {
      addArtist(db, id, name, 0);
    }
    const finding = auditLibrary(db).findings.find((f) => f.rule === 'fragmented_artist');
    expect(finding?.subject).toBe('arbase');
    expect(finding?.severity).toBe('medium');
    expect(finding?.message).toContain('merge into "Sanampay"');
  });

  it('never routes a fragmented artist to deletion — the music itself is real', () => {
    addArtist(db, 'arb2', 'Sanampay', 1);
    addArtist(db, 'arf4', 'Sanampay, V. PARRA', 0);
    addArtist(db, 'arf5', 'Sanampay, D.P.', 0);
    expect(DELETABLE_RULES).not.toContain('fragmented_artist');
  });

  it('never routes a DJ-set artist to deletion — the music itself is real', () => {
    addArtist(db, 'ard2', 'Secret Cinema B2B Egbert', 1);
    addAlbum(db, {
      id: 'ald2',
      name: 'Some Set',
      artist: 'Secret Cinema B2B Egbert',
      artistId: 'ard2',
    });
    addSong(db, 'sd2', 'ald2', 'ard2');
    const finding = auditLibrary(db).findings.find((f) => f.rule === 'djset_artist');
    // Ambiguous (two acts), so no merge target is suggested…
    expect(finding?.message).toContain('needs a human decision');
    // …and the rule is absent from the deletable set entirely.
    expect(DELETABLE_RULES as string[]).not.toContain('djset_artist');
  });

  it('flags a numeric artist (101) without flagging the real album title', () => {
    addArtist(db, 'arn', '101', 1);
    addAlbum(db, {
      id: 'aln',
      name: '1989',
      artist: '101',
      artistId: 'arn',
      songCount: 10,
      classification: 'album',
    });
    for (let i = 0; i < 10; i++) addSong(db, `sn${i}`, 'aln', 'arn');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('numeric_artist');
    // "1989" is a multi-track album title — must NOT be flagged as a numeric single.
    expect(rules).not.toContain('numeric_single');
  });

  it('still flags the genuine single-track warez albums under a real artist', () => {
    // Both real prod hits: a real artist, a real track title, ONE track. The
    // corroboration the issue originally proposed (junk artist OR no real
    // titles) is satisfied by neither, so it would have taken the rule to zero
    // findings rather than to two — this asserts it did not.
    addArtist(db, 'arl', 'Nestor En Bloque', 1);
    addAlbum(db, {
      id: 'all',
      name: 'LOSERPOWER.ORG - VOLUMEN 8',
      artist: 'Nestor En Bloque',
      artistId: 'arl',
      songCount: 1,
    });
    addSong(db, 'sl', 'all', 'arl', 'Vas A Volver');

    addArtist(db, 'are', 'Cassian', 1);
    addAlbum(db, {
      id: 'ale',
      name: 'Most Wanted 80 Djs Chart Top 53 Tracks - ElectronicFresh.com',
      artist: 'Cassian',
      artistId: 'are',
      songCount: 1,
    });
    addSong(db, 'se', 'ale', 'are', 'Magics');

    const flagged = auditLibrary(db)
      .findings.filter((f) => f.rule === 'watermark_album')
      .map((f) => f.subject)
      .sort();
    expect(flagged).toEqual(['ale', 'all']);
  });

  it('still flags a multi-track watermark album when an axis other than count fails', () => {
    // Many tracks and real titles, but the ARTIST is itself a watermark — a pool
    // dump, not a release. The conjunction must not be satisfied by count alone.
    addArtist(db, 'arp', 'musicauno.com', 1);
    addAlbum(db, {
      id: 'alp',
      name: 'Remix Pack Vol 3 - musicauno.com',
      artist: 'musicauno.com',
      artistId: 'arp',
      songCount: 12,
      classification: 'album',
    });
    for (let i = 0; i < 12; i++) addSong(db, `sp${i}`, 'alp', 'arp', `Real Song ${i}`);

    // Many tracks and a real artist, but every file is named after the watermark,
    // so there is no real music to lose.
    addArtist(db, 'arq', 'Some Artist', 1);
    addAlbum(db, {
      id: 'alq',
      name: 'ftpdjemilio.com',
      artist: 'Some Artist',
      artistId: 'arq',
      songCount: 9,
      classification: 'album',
    });
    for (let i = 0; i < 9; i++) addSong(db, `sq${i}`, 'alq', 'arq', 'ftpdjemilio.com');

    const flagged = auditLibrary(db)
      .findings.filter((f) => f.rule === 'watermark_album')
      .map((f) => f.subject)
      .sort();
    expect(flagged).toEqual(['alp', 'alq']);
  });

  it('flags a track-number-titled one-track single only when the ARTIST is junk too', () => {
    // A mis-parsed disc/track number lands next to a mis-parsed artist.
    addArtist(db, 'arj', 'musicauno.com', 1);
    addAlbum(db, { id: 'alj', name: '07', artist: 'musicauno.com', artistId: 'arj', songCount: 1 });
    addSong(db, 'sj', 'alj', 'arj');
    expect(auditLibrary(db).findings.map((f) => f.rule)).toContain('numeric_single');
  });

  // Issue #705: every numeric single flagged on the prod library was a REAL release
  // — "777" (Latto), "2000" (Manuel Turizo), "666", "222", "7171". A one-track album
  // with a numeric title is exactly what a real numeric-titled single looks like, so
  // the single-track guard the predicate recommends cannot discriminate at all.
  it('does not flag a real numeric-titled single by a real artist', () => {
    addArtist(db, 'ar1', 'Latto', 1);
    addAlbum(db, { id: 'aln', name: '777', artist: 'Latto', artistId: 'ar1', songCount: 1 });
    addSong(db, 's1', 'aln', 'ar1', 'Big Energy');
    expect(auditLibrary(db).findings.map((f) => f.rule)).not.toContain('numeric_single');
  });

  it('detects a mis-split album (>=3 singles sharing a title)', () => {
    addArtist(db, 'a', 'x', 3);
    for (let i = 0; i < 4; i++) {
      addArtist(db, `mart${i}`, `${100 + i}`, 1);
      addAlbum(db, {
        id: `mal${i}`,
        name: 'María de Buenos Aires',
        artist: `${100 + i}`,
        artistId: `mart${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ms${i}`, `mal${i}`, `mart${i}`);
    }
    const missplit = checkMisSplitAlbums(db);
    expect(missplit).toHaveLength(1);
    expect(missplit[0]!.message).toContain('4 one-track singles');
  });

  it('flags integrity drift: album_count + song_count mismatch', () => {
    addArtist(db, 'ar1', 'Soda Stereo', 5); // claims 5 albums, has 1
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      songCount: 9,
      classification: 'album',
    });
    addSong(db, 's1', 'al1', 'ar1'); // only 1 song, claims 9
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('album_count_mismatch');
    expect(rules).toContain('album_song_count_mismatch');
  });

  it('flags render gaps: missing year, missing artwork', () => {
    addArtist(db, 'ar1', 'Soda Stereo', 1);
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      songCount: 1,
      classification: 'album',
      year: null,
      cover: null,
    });
    addSong(db, 's1', 'al1', 'ar1');
    const rules = auditLibrary(db).findings.map((f) => f.rule);
    expect(rules).toContain('missing_year');
    expect(rules).toContain('missing_artwork');
  });

  it('flags an orphan artist with no releases', () => {
    addArtist(db, 'orphan', 'Ghost', 0);
    expect(auditLibrary(db).findings.map((f) => f.rule)).toContain('orphan_artist');
  });

  it('selectPollutionTargets expands a watermark artist to all its albums', () => {
    addArtist(db, 'arw', 'ftpdjemilio.com', 2);
    addAlbum(db, { id: 'w1', name: 'Track A', artist: 'ftpdjemilio.com', artistId: 'arw' });
    addAlbum(db, { id: 'w2', name: 'Track B', artist: 'ftpdjemilio.com', artistId: 'arw' });
    // Files named after the watermark: nothing real to lose, so both are deletable.
    addSong(db, 's1', 'w1', 'arw', 'ftpdjemilio.com');
    addSong(db, 's2', 'w2', 'arw', 'ftpdjemilio.com');
    const { targets } = selectPollutionTargets(db, ['watermark_artist']);
    expect(targets.map((t) => t.albumId).sort()).toEqual(['w1', 'w2']);
  });

  // Issue #705, the case that motivated the whole guard. `You Love Dance.TV` is a
  // genuine DJ-pool watermark as an ARTIST — and on prod it held a real 4 Strings
  // track, "Acid Phase". Expanding a watermark artist to "delete all its albums"
  // therefore destroyed real music. The remediation is a retag, never a delete.
  it('protects a watermark artist whose tracks carry real titles', () => {
    addArtist(db, 'arw', 'You Love Dance.TV', 1);
    addAlbum(db, { id: 'w1', name: 'Vol 3', artist: 'You Love Dance.TV', artistId: 'arw' });
    addSong(db, 's1', 'w1', 'arw', 'Acid Phase');
    const res = selectPollutionTargets(db, ['watermark_artist']);
    expect(res.targets).toEqual([]);
    expect(res.protectedRealAudio).toBe(1);
  });

  // Issue #705: `Coolio.com` is Coolio's genuine 2001 album — 14 real tracks, one
  // `--apply` away from deletion because the title ends in ".com". Issue #819
  // moved the catch one layer earlier: it is no longer *flagged*, so it never
  // reaches the delete guard that used to be the only thing saving it. Both
  // layers are asserted — the guard still has to hold for every other rule.
  it('does not flag a real album whose title merely looks like a domain', () => {
    addArtist(db, 'arc', 'Coolio', 1);
    addAlbum(db, {
      id: 'alc',
      name: 'Coolio.com',
      artist: 'Coolio',
      artistId: 'arc',
      songCount: 14,
    });
    addSong(db, 'sc', 'alc', 'arc', 'Ghetto Square Dance');
    expect(auditLibrary(db).findings.map((f) => f.rule)).not.toContain('watermark_album');
    expect(selectPollutionTargets(db, DELETABLE_RULES).targets).toEqual([]);
  });

  // Issue #705: `!!!` (chk chk chk) is a real band. `isPlaceholderArtist` answers
  // "usable as a Lidarr query key?", under which `!!!` normalizes to "" and reads
  // as a placeholder — the wrong question to authorise a delete.
  it('does not treat a punctuation-only real band as a placeholder', () => {
    addArtist(db, 'arb', '!!!', 1);
    addAlbum(db, {
      id: 'alb',
      name: 'Myth Takes',
      artist: '!!!',
      artistId: 'arb',
      songCount: 1,
      classification: 'single',
    });
    addSong(db, 'sb', 'alb', 'arb', 'Must Be the Moon');
    expect(auditLibrary(db).findings.map((f) => f.rule)).not.toContain('placeholder_single');
  });

  it('PROTECTS a real-named mis-split from deletion even when members trip a delete rule', () => {
    // A real album fragmented into placeholder-artist singles sharing a real title.
    for (let i = 0; i < 3; i++) {
      addArtist(db, `n${i}`, '<Desconocido>', 1);
      addAlbum(db, {
        id: `m${i}`,
        name: 'María de Buenos Aires',
        artist: '<Desconocido>',
        artistId: `n${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ms${i}`, `m${i}`, `n${i}`);
    }
    // Members trip placeholder_single, but the cluster has a real title → protected.
    const { targets, protectedMisSplit } = selectPollutionTargets(db, ['placeholder_single']);
    expect(targets).toEqual([]);
    expect(protectedMisSplit).toBeGreaterThan(0);
  });

  it('does NOT protect a watermark-named mis-split (stays deletable)', () => {
    for (let i = 0; i < 3; i++) {
      addArtist(db, `w${i}`, `Artist ${i}`, 1);
      addAlbum(db, {
        id: `wm${i}`,
        name: 'MUSICAUNO.COM',
        artist: `Artist ${i}`,
        artistId: `w${i}`,
        songCount: 1,
        classification: 'single',
      });
      addSong(db, `ws${i}`, `wm${i}`, `w${i}`);
    }
    // Songs carry a real title ('t'), so the real-audio guard protects them: junk
    // metadata is not junk audio (issue #705). They are still *reported*, just not
    // deletable — the remediation is a retag.
    const kept = selectPollutionTargets(db, ['watermark_album']);
    expect(kept.targets).toEqual([]);
    expect(kept.protectedRealAudio).toBe(3);

    // Retitle the files after the watermark itself — now there is no real music to
    // lose and the album is a genuine dumping ground, so it becomes deletable.
    for (let i = 0; i < 3; i++) {
      db.run(`UPDATE library_songs SET title = 'musicauno.com' WHERE id = ?`, [`ws${i}`]);
    }
    const { targets } = selectPollutionTargets(db, ['watermark_album']);
    expect(targets.map((t) => t.albumId).sort()).toEqual(['wm0', 'wm1', 'wm2']);
  });

  it('summarize ranks high severity first and sets ok=false on any high finding', () => {
    const report = summarize(db, [
      { rule: 'missing_year', severity: 'low', subject: 'x', message: '' },
      { rule: 'watermark_artist', severity: 'high', subject: 'y', message: '' },
    ]);
    expect(report.summary[0]!.rule).toBe('watermark_artist');
    expect(report.ok).toBe(false);
    expect(report.highSeverityCount).toBe(1);
  });
});

describe('checkRenderGaps — missing_artwork measures canonical covers (issue #732)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    addArtist(db, 'ar1', 'Soda Stereo', 1);
  });

  function rulesFor(albumId: string): string[] {
    return checkRenderGaps(db)
      .filter((f) => f.subject === albumId)
      .map((f) => f.rule);
  }

  it('fires for an album whose cover_art is the scanner-set id but has no canonical artwork row', () => {
    // The scanner always writes cover_art = <album id>; the rule must not read it as "has art".
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      classification: 'album',
      year: 1992,
      cover: 'al1',
    });
    expect(rulesFor('al1')).toContain('missing_artwork');
  });

  it('does not fire when a kind=album canonical artwork row exists', () => {
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      classification: 'album',
      year: 1992,
      cover: 'al1',
    });
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('al1','album','u',1)`,
    );
    expect(rulesFor('al1')).not.toContain('missing_artwork');
  });

  it('ignores artwork rows of kind=artist when judging an album', () => {
    addAlbum(db, {
      id: 'al1',
      name: 'Dynamo',
      artist: 'Soda Stereo',
      artistId: 'ar1',
      classification: 'album',
      year: 1992,
      cover: 'al1',
    });
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('al1','artist','u',1)`,
    );
    expect(rulesFor('al1')).toContain('missing_artwork');
  });
});
