import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { normalizeArtistForGrouping as norm } from './album-grouping.js';
import { recordListenerReport, type CurationFlag } from './curation-flags.js';
import { listCreditMembers } from './artist-split.js';
import { artistIdFor } from './library-scanner.js';
import {
  closeResolvedJointCards,
  fileJointCreditCard,
  findUnresolvedJointCredits,
  jointCreditFacts,
  jointCreditOptions,
  withJointCreditCard,
} from './joint-credits.js';

const known = (...names: string[]) => ({
  confirmedArtists: new Set(names.map(norm)),
  canonicalWhole: new Set<string>(),
  explicitSplits: new Map<string, string[]>(),
});
const row = (credit: string, over: Partial<{ songs: number; links: number }> = {}) => ({
  credit,
  songs: 1,
  links: 1,
  songId: `song-${credit}`,
  ...over,
});

describe('listCreditMembers', () => {
  it('splits a bare slash when a side is a known artist', () => {
    expect(listCreditMembers('Gramatik/Luxas', known('Gramatik'))).toEqual(['Gramatik', 'Luxas']);
  });

  it('keeps a bare slash whole when neither side is known', () => {
    expect(listCreditMembers('AC/DC', known('Rihanna'))).toEqual(['AC/DC']);
  });

  it('does not shred a member that carries its own delimiter', () => {
    expect(listCreditMembers('Wisin & Yandel/ROSALÍA', known('Wisin & Yandel'))).toEqual([
      'Wisin & Yandel',
      'ROSALÍA',
    ]);
    expect(listCreditMembers('Tyler, The Creator/Kali Uchis', known('Tyler, The Creator'))).toEqual(
      ['Tyler, The Creator', 'Kali Uchis'],
    );
  });

  it('counts a member as known when each of its own parts is', () => {
    expect(listCreditMembers('Oden & Fatzo/Poppy', known('Oden', 'Fatzo'))).toEqual([
      'Oden & Fatzo',
      'Poppy',
    ]);
  });

  it('always splits at a semicolon, and keeps a real slash name inside it', () => {
    expect(listCreditMembers('CamelPhat;Au/Ra', known('CamelPhat'))).toEqual([
      'CamelPhat',
      'Au/Ra',
    ]);
    expect(listCreditMembers('Bomba Estéreo; Rawayana', known())).toEqual([
      'Bomba Estéreo',
      'Rawayana',
    ]);
  });

  it('treats a run of spaces as a stripped separator', () => {
    expect(listCreditMembers('Charly García  Pedro Aznar', known())).toEqual([
      'Charly García',
      'Pedro Aznar',
    ]);
  });

  it('leaves an ordinary name alone', () => {
    expect(listCreditMembers('Wisin & Yandel', known('Wisin', 'Yandel'))).toEqual([
      'Wisin & Yandel',
    ]);
  });
});

describe('findUnresolvedJointCredits', () => {
  it('reports a credit with fewer links than members, worst first', () => {
    const found = findUnresolvedJointCredits(
      [row('Mina/Miguel Bosé'), row('Gramatik/Luxas', { songs: 36 })],
      known('Gramatik', 'Miguel Bosé'),
    );
    expect(found.map((f) => [f.credit, f.songs])).toEqual([
      ['Gramatik/Luxas', 36],
      ['Mina/Miguel Bosé', 1],
    ]);
    expect(found[0]!.members).toEqual([
      { name: 'Gramatik', known: true },
      { name: 'Luxas', known: false },
    ]);
  });

  it('marks whether the scanner rule settles it or a human must', () => {
    const [auto, human] = findUnresolvedJointCredits(
      [row('Gramatik/Luxas', { songs: 2 }), row('Duo Rey Silva/Mario Catalán')],
      known('Gramatik'),
    );
    expect(auto!.decision).toBe('auto');
    expect(human!.decision).toBe('human');
    expect(human!.members.map((m) => m.name)).toEqual(['Duo Rey Silva', 'Mario Catalán']);
  });

  it('skips a credit whose links already cover its members', () => {
    expect(
      findUnresolvedJointCredits([row('Gramatik/Luxas', { links: 2 })], known('Gramatik')),
    ).toEqual([]);
  });

  it('skips a credit whose names an alias makes one artist', () => {
    const credit = 'Osvaldo Pugliese/Orquesta Osvaldo Pugliese';
    expect(
      findUnresolvedJointCredits([row(credit, { links: 1 })], {
        ...known('Osvaldo Pugliese'),
        aliases: new Map([[norm('Orquesta Osvaldo Pugliese'), 'Osvaldo Pugliese']]),
      }),
    ).toEqual([]);
    expect(
      findUnresolvedJointCredits([row(credit, { links: 1 })], known('Osvaldo Pugliese')),
    ).toHaveLength(1);
  });

  it('skips what a decision already settled', () => {
    expect(
      findUnresolvedJointCredits([row('AC/DC')], {
        ...known(),
        canonicalWhole: new Set([norm('AC/DC')]),
      }),
    ).toEqual([]);
    expect(
      findUnresolvedJointCredits([row('Gordo/Feid')], {
        ...known(),
        explicitSplits: new Map([[norm('Gordo/Feid'), ['Gordo', 'Feid']]]),
      }),
    ).toEqual([]);
  });

  it('ignores a credit with no list separator', () => {
    expect(findUnresolvedJointCredits([row('Bob Marley & The Wailers')], known())).toEqual([]);
  });
});

describe('jointCreditOptions', () => {
  it('offers a split and a one-act answer', () => {
    const [split, oneAct] = jointCreditOptions('Mina/Miguel Bosé', ['Mina', 'Miguel Bosé']);
    expect(split!.effect).toEqual({
      type: 'artist-split',
      rawName: 'Mina/Miguel Bosé',
      members: ['Mina', 'Miguel Bosé'],
    });
    expect(split!.label).toContain('Mina + Miguel Bosé');
    expect(oneAct!.effect).toEqual({ type: 'artist-single', rawName: 'Mina/Miguel Bosé' });
  });

  it('keeps a long member list inside the label cap', () => {
    const members = Array.from({ length: 8 }, (_, i) => `A Fairly Long Artist Name ${i}`);
    const [split] = jointCreditOptions(members.join('/'), members);
    expect(split!.label.length).toBeLessThanOrEqual(80);
  });

  it('suppresses the split option when a proposed member still holds a comma (#1613)', () => {
    const options = jointCreditOptions('Pete Tong, HER-O, Jules Buckley, Au/Ra', [
      'Pete Tong, HER-O, Jules Buckley, Au',
      'Ra',
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]!.id).toBe('joint-one-act');
    expect(options[0]!.effect).toEqual({
      type: 'artist-single',
      rawName: 'Pete Tong, HER-O, Jules Buckley, Au/Ra',
    });
  });

  it('suppresses the split option when proposed members look like sentences or promo text (#1613)', () => {
    const credit = 'This EP is for you. Pre-order/pre-save now and be part of this journey';
    const options = jointCreditOptions(credit, [
      'This EP is for you. Pre-order',
      'pre-save now and be part of this journey',
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]!.id).toBe('joint-one-act');
    expect(options[0]!.effect).toEqual({
      type: 'artist-single',
      rawName: credit,
    });
  });

  it('preserves the split option for legitimate artists with initials or periods', () => {
    const options = jointCreditOptions('J. Cole/Dr. Dre', ['J. Cole', 'Dr. Dre']);
    expect(options).toHaveLength(2);
    expect(options[0]!.id).toBe('joint-split');
    expect(options[1]!.id).toBe('joint-one-act');
  });
});

describe('over the database', () => {
  let db: Database;

  const song = (id: string, artist: string, links: string[] = []) => {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES (?, 'A', ?, 'x', 1, 0, '2024-01-01', 0)`,
      [`alb-${id}`, artist],
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at, hidden)
       VALUES (?, ?, ?, ?, 'x', 200, ?, 0, 320, 'opus', 'audio/ogg', '2024-01-01', 0, 0)`,
      [id, `alb-${id}`, id, artist, `/m/${id}.opus`],
    );
    links.forEach((name, i) => {
      const artistId = artistIdFor(name);
      db.run(`INSERT OR IGNORE INTO library_artists (id, name, synced_at) VALUES (?, ?, 0)`, [
        artistId,
        name,
      ]);
      db.run(
        `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, 'primary', ?)`,
        [id, artistId, i],
      );
    });
  };

  const flag = (over: Partial<CurationFlag> = {}): CurationFlag => ({
    id: 1,
    targetKind: 'song',
    targetId: 'mina',
    reason: 'misplaced',
    createdBy: 'u1',
    createdAt: 0,
    source: 'listener',
    reportCount: 1,
    caseKind: null,
    optionsJson: null,
    question: null,
    snoozedUntil: null,
    ...over,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    song('solo', 'Miguel Bosé', ['Miguel Bosé']);
    song('mina', 'Mina/Miguel Bosé', ['Miguel Bosé']);
  });

  it('jointCreditFacts counts credits and bounds the worklist', () => {
    song('b', 'Duo Rey/Mario', ['Duo Rey/Mario']);
    song('c', 'Miguel Bosé/Rafa', ['Miguel Bosé/Rafa']);
    const facts = jointCreditFacts(db, 1);
    expect(facts.metric).toMatchObject({ credits: 3, songs: 3, auto: 2, human: 1, fakeArtists: 2 });
    expect(facts.worklist).toHaveLength(1);
  });

  describe('closeResolvedJointCards (#1610)', () => {
    const openCards = () =>
      db
        .query<{ target_id: string }, []>(
          'SELECT target_id FROM curation_flags WHERE resolved_at IS NULL',
        )
        .all()
        .map((r) => r.target_id);

    it('closes a filed card once its credit resolved, and keeps the open ones', () => {
      fileJointCreditCard(db, 'Mina/Miguel Bosé', ['Mina', 'Miguel Bosé']);
      song('open', 'Duo Rey/Mario', ['Duo Rey/Mario']);
      fileJointCreditCard(db, 'Duo Rey/Mario', ['Duo Rey', 'Mario']);
      expect(closeResolvedJointCards(db)).toBe(0);

      db.run(`DELETE FROM library_song_artists WHERE song_id = 'mina'`);
      for (const [i, name] of ['Mina', 'Miguel Bosé'].entries()) {
        db.run(
          `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES ('mina', ?, 'primary', ?)`,
          [artistIdFor(name), i],
        );
      }

      expect(closeResolvedJointCards(db)).toBe(1);
      expect(openCards()).toEqual(['open']);
    });

    it('closes a card whose song is gone', () => {
      fileJointCreditCard(db, 'Mina/Miguel Bosé', ['Mina', 'Miguel Bosé']);
      db.run(`DELETE FROM library_songs WHERE id = 'mina'`);
      expect(closeResolvedJointCards(db)).toBe(1);
    });

    it('leaves a listener report alone, which may be about something else', () => {
      recordListenerReport(db, {
        targetKind: 'song',
        targetId: 'solo',
        reason: 'misplaced',
        reasonId: 'misplaced',
        userId: 'u1',
      });
      expect(closeResolvedJointCards(db)).toBe(0);
      expect(openCards()).toEqual(['solo']);
    });
  });

  it('gives a listener report on such a song a card', () => {
    const out = withJointCreditCard(db, flag());
    expect(out.caseKind).toBe('identity');
    expect(out.question).toContain('Mina/Miguel Bosé');
    expect(JSON.parse(out.optionsJson!)[0].effect.type).toBe('artist-split');
  });

  it('leaves a report about something else alone', () => {
    expect(withJointCreditCard(db, flag({ reason: 'quality' })).optionsJson).toBeNull();
  });

  it('leaves a report on a resolved credit alone', () => {
    expect(withJointCreditCard(db, flag({ targetId: 'solo' })).optionsJson).toBeNull();
  });

  it('never replaces a card an agent already filed', () => {
    const optionsJson = JSON.stringify([{ id: 'x', label: 'X', effect: { type: 'resolve-only' } }]);
    expect(withJointCreditCard(db, flag({ optionsJson })).optionsJson).toBe(optionsJson);
  });
});
