import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  deriveMbidAliases,
  isPlaceholderAliasKey,
  loadSplitAuthority,
  recordAcquiredArtistIdentity,
  repairArtistIdentityNfc,
  upsertArtistAlias,
  upsertArtistIdentity,
} from './artist-identity-store.js';
import { artistIdFor } from './library-scanner.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seed(artist: string, albumArtist = artist): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', 'T', ?, 'art', ?, 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1)`,
    [`${artist}-${Math.random()}`, artist, albumArtist, `${artist}/Album.opus`],
  );
}

describe('loadSplitAuthority', () => {
  it('confirms atomic library artist names but never a compound (self-confirmation guard)', () => {
    seed('Charly García');
    seed('Luis Alberto Spinetta');
    seed('Charly García y Luis Alberto Spinetta'); // compound — must NOT confirm itself
    const auth = loadSplitAuthority(db);
    expect(auth.confirmedArtists.has('charly garcia')).toBe(true);
    expect(auth.confirmedArtists.has('luis alberto spinetta')).toBe(true);
    expect(auth.confirmedArtists.has('charly garcia y luis alberto spinetta')).toBe(false);
  });

  it('contributes canonicalWhole from a "single" authority row', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Wisin & Yandel'),
      rawName: 'Wisin & Yandel',
      decision: 'single',
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.canonicalWhole.has('wisin & yandel')).toBe(true);
  });

  it('contributes confirmed members from a "split" authority row', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Bob Marley, Peter Tosh'),
      rawName: 'Bob Marley, Peter Tosh',
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.confirmedArtists.has('bob marley')).toBe(true);
    expect(auth.confirmedArtists.has('peter tosh')).toBe(true);
  });

  it('ignores an "unknown" row (no opinion — leaves it to library-only logic)', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Some, Weird x Thing'),
      rawName: 'Some, Weird x Thing',
      decision: 'unknown',
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.canonicalWhole.size).toBe(0);
    expect(auth.confirmedArtists.size).toBe(0);
  });
});

describe('upsertArtistIdentity precedence', () => {
  const key = artistIdFor('Bob Marley, Peter Tosh');
  const base = { artistKey: key, rawName: 'Bob Marley, Peter Tosh' };

  function decision(): { decision: string; source: string } | null {
    return db
      .query<{ decision: string; source: string }, [string]>(
        `SELECT decision, source FROM library_artist_identity WHERE artist_key = ?`,
      )
      .get(key);
  }

  it('a background write never clobbers a user decision; another user write can', () => {
    upsertArtistIdentity(db, { ...base, decision: 'single', source: 'user' });
    upsertArtistIdentity(db, {
      ...base,
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'lidarr',
    });
    expect(decision()).toEqual({ decision: 'single', source: 'user' });

    upsertArtistIdentity(db, {
      ...base,
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'user',
    });
    expect(decision()).toEqual({ decision: 'split', source: 'user' });
  });

  it('background writes still replace background rows', () => {
    upsertArtistIdentity(db, { ...base, decision: 'unknown', source: 'lidarr' });
    upsertArtistIdentity(db, { ...base, decision: 'single', source: 'lidarr' });
    expect(decision()).toEqual({ decision: 'single', source: 'lidarr' });
  });
});

describe('deriveMbidAliases', () => {
  /** Seed one library artist with `songs` songs and a cached MBID link. */
  function seedArtist(name: string, mbid: string, songs: number, albums = 0): void {
    const id = artistIdFor(name);
    db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`, [
      id,
      name,
      albums,
    ]);
    db.run(
      `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, NULL, ?, 1)`,
      [id, mbid],
    );
    for (let i = 0; i < songs; i++) {
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
         VALUES (?, 'alb', 'T', ?, ?, 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1)`,
        [`${name}-${i}`, name, id, `${name}/${i}.opus`],
      );
    }
  }

  it('proposes aliasing the fewer-songs spelling to the canonical one on MBID equality', () => {
    seedArtist('Snoop Dogg', 'mbid-snoop', 5);
    seedArtist('Snoop Dog', 'mbid-snoop', 1);
    seedArtist('Dr. Dre', 'mbid-dre', 3); // unique MBID — untouched

    const proposals = deriveMbidAliases(db);

    expect(proposals).toEqual([
      {
        aliasNorm: 'snoop dog',
        variantName: 'Snoop Dog',
        canonicalName: 'Snoop Dogg',
        mbid: 'mbid-snoop',
      },
    ]);
    // Proposals only — nothing written without apply (human-gated; see docblock).
    expect(loadSplitAuthority(db).aliases.size).toBe(0);

    deriveMbidAliases(db, { apply: true });
    const auth = loadSplitAuthority(db);
    expect(auth.aliases.get('snoop dog')).toBe('Snoop Dogg');
    expect(auth.aliases.has('snoop dogg')).toBe(false);
    expect(auth.aliases.has('dr. dre')).toBe(false);
  });

  it('never overwrites a user-sourced alias', () => {
    seedArtist('Snoop Dogg', 'mbid-snoop', 5);
    seedArtist('Snoop Dog', 'mbid-snoop', 1);
    upsertArtistAlias(db, {
      aliasNorm: 'snoop dog',
      canonicalName: 'Snoop D-O-Double-G',
      source: 'user',
    });

    deriveMbidAliases(db, { apply: true });

    expect(loadSplitAuthority(db).aliases.get('snoop dog')).toBe('Snoop D-O-Double-G');
  });

  it('proposes nothing when every MBID is unique', () => {
    seedArtist('Charly García', 'mbid-charly', 4);
    seedArtist('Fito Páez', 'mbid-fito', 2);
    expect(deriveMbidAliases(db, { apply: true })).toHaveLength(0);
    expect(loadSplitAuthority(db).aliases.size).toBe(0);
  });
});

describe('recordAcquiredArtistIdentity', () => {
  const key = artistIdFor('Bob Marley & The Wailers');

  it('writes a single/lidarr identity row and caches the MBID link', () => {
    recordAcquiredArtistIdentity(db, {
      artistKey: key,
      artistName: 'Bob Marley & The Wailers',
      mbid: 'mbid-wailers',
    });
    const identity = db
      .query<{ decision: string; source: string }, [string]>(
        'SELECT decision, source FROM library_artist_identity WHERE artist_key = ?',
      )
      .get(key);
    expect(identity).toEqual({ decision: 'single', source: 'lidarr' });
    const link = db
      .query<{ mbid: string }, [string]>(
        'SELECT mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(key);
    expect(link?.mbid).toBe('mbid-wailers');
    // The canonical compound is now protected as one act for the scanner.
    expect(loadSplitAuthority(db).canonicalWhole.has('bob marley & the wailers')).toBe(true);
  });

  it('preserves an existing lidarr_id when refreshing the MBID link', () => {
    db.run(
      `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, 42, 'old', 1)`,
      [key],
    );
    recordAcquiredArtistIdentity(db, {
      artistKey: key,
      artistName: 'Bob Marley & The Wailers',
      mbid: 'new',
    });
    const link = db
      .query<{ lidarr_id: number | null; mbid: string }, [string]>(
        'SELECT lidarr_id, mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(key);
    expect(link).toEqual({ lidarr_id: 42, mbid: 'new' });
  });

  it('skips the link entirely when no MBID is available', () => {
    recordAcquiredArtistIdentity(db, { artistKey: key, artistName: 'Bob Marley & The Wailers' });
    const link = db
      .query<{ 1: number }, [string]>('SELECT 1 FROM artist_discography_links WHERE artist_id = ?')
      .get(key);
    expect(link).toBeNull();
    expect(
      db
        .query<{ 1: number }, [string]>(
          'SELECT 1 FROM library_artist_identity WHERE artist_key = ?',
        )
        .get(key),
    ).not.toBeNull();
  });
});

/**
 * Issue #950: `[Traditional]` is what folk, classical and choral rips carry when
 * there is no known composer — it identifies no performer. Aliased to
 * `Luciano Pavarotti` on prod, so any future file tagged that way would land in
 * his discography at scan time with no signal, and no audit rule able to see it:
 * the artist resolves cleanly and `fragmented_artist` sees one artist, not two.
 */
describe('placeholder-keyed artist aliases are refused at the door', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function aliasCount(): number {
    return db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_artist_aliases').get()!.c;
  }

  it('refuses a placeholder key even from a deliberate user merge', () => {
    expect(
      upsertArtistAlias(db, {
        aliasNorm: 'traditional',
        canonicalName: 'Luciano Pavarotti',
        source: 'user',
      }),
    ).toBe(false);
    expect(aliasCount()).toBe(0);
  });

  it('refuses a key too generic to identify the artist it points at', () => {
    // normalizeArtistForGrouping("&ME") strips the ampersand, so the key for a
    // real artist is the bare English word "me" — correct today, and a trap for
    // any artist genuinely named "Me".
    for (const k of ['me', 'various', 'va', 'unknown', 'artist', '[traditional]', '']) {
      expect(isPlaceholderAliasKey(k)).toBe(true);
    }
  });

  it('still writes an ordinary spelling variant', () => {
    expect(
      upsertArtistAlias(db, {
        aliasNorm: 'pericos',
        canonicalName: 'Los Pericos',
        source: 'user',
      }),
    ).toBe(true);
    expect(aliasCount()).toBe(1);
    expect(isPlaceholderAliasKey('pericos')).toBe(false);
    expect(isPlaceholderAliasKey('metallica')).toBe(false);
  });
});

// Issue #1440: a curator's client sent "Anyma & Rebu\u0304ke" decomposed (NFD),
// and it was stored as sent — while every tag string is NFC since #961.
describe('artist identity text is stored NFC', () => {
  const nfd = 'Anyma & Rebu\u0304ke';
  const nfc = 'Anyma & Reb\u016Bke';

  function identity(): { raw_name: string; members: string | null } | null {
    return db
      .query<{ raw_name: string; members: string | null }, []>(
        'SELECT raw_name, members FROM library_artist_identity',
      )
      .get();
  }

  it('upsertArtistIdentity composes the raw name and the members', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor(nfd),
      rawName: nfd,
      decision: 'split',
      members: ['Anyma', 'Rebu\u0304ke'],
      source: 'user',
    });
    const row = identity()!;
    expect(row.raw_name).toBe(nfc);
    expect(JSON.parse(row.members!)).toEqual(['Anyma', 'Reb\u016Bke']);
  });

  it('upsertArtistAlias composes the canonical name the scanner mints from', () => {
    upsertArtistAlias(db, {
      aliasNorm: 'donny benet',
      canonicalName: 'Donny Bene\u0301t',
      source: 'user',
    });
    const row = db
      .query<{ canonical_name: string }, []>('SELECT canonical_name FROM library_artist_aliases')
      .get()!;
    expect(row.canonical_name).toBe('Donny Ben\u00E9t');
  });

  it('repairArtistIdentityNfc composes rows written before the fix and touches nothing else', () => {
    const put = (key: string, raw: string, members: string | null, source: string) =>
      db.run(
        `INSERT INTO library_artist_identity (artist_key, raw_name, decision, members, source, checked_at)
         VALUES (?, ?, 'split', ?, ?, 42)`,
        [key, raw, members, source],
      );
    put(artistIdFor(nfd), nfd, JSON.stringify(['Anyma', 'Rebu\u0304ke']), 'user');
    put(artistIdFor('Bob Marley, Peter Tosh'), 'Bob Marley, Peter Tosh', null, 'lidarr');
    db.run(
      `INSERT INTO library_artist_aliases (alias_norm, canonical_name, mbid, source, created_at)
       VALUES ('donny benet', 'Donny Bene\u0301t', NULL, 'user', 7), ('pericos', 'Los Pericos', NULL, 'user', 7)`,
    );
    const before = db.query('SELECT * FROM library_artist_identity ORDER BY artist_key').all();

    expect(repairArtistIdentityNfc(db)).toEqual({ identity: 1, aliases: 1 });

    const after = db
      .query<Record<string, unknown>, []>(
        'SELECT * FROM library_artist_identity ORDER BY artist_key',
      )
      .all();
    const anyma = after.find((r) => r.artist_key === artistIdFor(nfc))!;
    expect(anyma.raw_name).toBe(nfc);
    expect(anyma.members).toBe(JSON.stringify(['Anyma', 'Reb\u016Bke']));
    // key, decision, source and checked_at are untouched — the key already folded both forms.
    expect(after.map((r) => ({ ...r, raw_name: 0, members: 0 }))).toEqual(
      (before as Record<string, unknown>[]).map((r) => ({ ...r, raw_name: 0, members: 0 })),
    );
    expect(after.find((r) => r.raw_name === 'Bob Marley, Peter Tosh')).toEqual(
      (before as Record<string, unknown>[]).find((r) => r.raw_name === 'Bob Marley, Peter Tosh'),
    );
    expect(
      db
        .query(
          'SELECT alias_norm, canonical_name, source, created_at FROM library_artist_aliases ORDER BY alias_norm',
        )
        .all(),
    ).toEqual([
      {
        alias_norm: 'donny benet',
        canonical_name: 'Donny Ben\u00E9t',
        source: 'user',
        created_at: 7,
      },
      { alias_norm: 'pericos', canonical_name: 'Los Pericos', source: 'user', created_at: 7 },
    ]);
    expect(repairArtistIdentityNfc(db)).toEqual({ identity: 0, aliases: 0 });
  });
});
