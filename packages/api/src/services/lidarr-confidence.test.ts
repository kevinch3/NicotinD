import { describe, it, expect } from 'bun:test';
import { corroboratesLidarrHit, cleanArtistKey, boundedEditDistance } from './lidarr-confidence';

const hit = (artistName: string) => ({ artistName });

describe('cleanArtistKey', () => {
  it('folds accents, case, punctuation and spacing to one key', () => {
    expect(cleanArtistKey('Tru La La')).toBe('trulala');
    expect(cleanArtistKey('Trulalá')).toBe('trulala');
    expect(cleanArtistKey('Wu-Tang Clan')).toBe('wutangclan');
    expect(cleanArtistKey('  Miño ')).toBe('mino');
  });
});

describe('boundedEditDistance', () => {
  it('returns the distance when within the cutoff', () => {
    // riki -> ricky is two edits (insert 'c', substitute i->y), not one.
    expect(boundedEditDistance('rikimaravilla', 'rickymaravilla', 3)).toBe(2);
    expect(boundedEditDistance('telzen', 'tenzen', 3)).toBe(1);
    expect(boundedEditDistance('abc', 'abc', 1)).toBe(0);
  });

  it('abandons early and returns null past the cutoff', () => {
    expect(boundedEditDistance('ipauta', 'carloipata', 2)).toBeNull();
    // length delta alone exceeds k — must not even run the DP
    expect(boundedEditDistance('a', 'abcdefghij', 2)).toBeNull();
  });

  it('is symmetric', () => {
    expect(boundedEditDistance('kitten', 'sitting', 5)).toBe(
      boundedEditDistance('sitting', 'kitten', 5),
    );
  });
});

describe('corroboratesLidarrHit — real prod pairs', () => {
  // ── must ACCEPT: genuine canonical-name drift (#211/#217 and friends) ──
  const accept: [string, string, string][] = [
    ['Eduardo Miño', 'Luis Eduardo Miño Naranjo', 'issue #211 flagship — query contained in hit'],
    ['La Mosca', 'La Mosca Tsé-Tsé', 'band full name'],
    ['Tru La La', 'Trulalá', 'spacing + accent variant'],
    ['Riki Maravilla', 'Ricky Maravilla', 'one-character spelling variant'],
    ['Al Fredo', 'DJ Al-Fredo', 'DJ prefix'],
    ['18 Kilates', 'Gerson, Bloque & 18 Kilates', 'hit is a superset credit'],
    ['Zamy Juárez Abad', 'Zamy Juárez', 'library name is the fuller one'],
    ['Arjona', 'Arjona', 'exact'],
  ];
  for (const [query, name, why] of accept) {
    it(`accepts ${JSON.stringify(query)} -> ${JSON.stringify(name)} (${why})`, () => {
      expect(corroboratesLidarrHit(query, hit(name))).toBe(true);
    });
  }

  // ── must REJECT ──
  const reject: [string, string, string][] = [
    ['2 MinutosTruenoDie Toten Hosen', '2', 'issue #212 — junk fuzzy hit, 3% coverage'],
    ['ME', 'Âme', 'documented false pair; too short to fuzzy-match'],
    ['IPAUTA', 'Carlo Ipata', 'unrelated artist'],
    ['Telzen', 'Tenzen', 'transposition on a short name — different artist'],
    ['Los Reyes del Cuarteto', 'Los Reyes del Mambo', 'differs at the distinctive token'],
  ];
  for (const [query, name, why] of reject) {
    it(`rejects ${JSON.stringify(query)} -> ${JSON.stringify(name)} (${why})`, () => {
      expect(corroboratesLidarrHit(query, hit(name))).toBe(false);
    });
  }

  it('never splits a real band name apart on coverage alone', () => {
    // A short hit that is a *prefix token* of a long query is still junk-shaped.
    expect(corroboratesLidarrHit('Die Toten HosenTruenoLos Piojos', hit('Die'))).toBe(false);
  });

  it('normalizes both sides itself rather than trusting Lidarr cleanName', () => {
    // Lidarr's cleanName strips English stopwords ("the"/"of"), so mixing it with
    // our key rejected these identical names. Regression guard — all found in prod.
    expect(corroboratesLidarrHit('Bob Marley & The Wailers', hit('Bob Marley & The Wailers'))).toBe(
      true,
    );
    expect(corroboratesLidarrHit('Agents Of Time', hit('Agents of Time'))).toBe(true);
    expect(corroboratesLidarrHit('Trulala', hit('T R U L A L A'))).toBe(true);
  });

  it('accepts a punctuation-only artist name against itself', () => {
    // "!!!" is a real band (in prod); its clean key is empty.
    expect(corroboratesLidarrHit('!!!', hit('!!!'))).toBe(true);
    expect(corroboratesLidarrHit('!!!', hit('???'))).toBe(false);
  });

  it('handles empty / degenerate input without throwing', () => {
    expect(corroboratesLidarrHit('', hit('Anything'))).toBe(false);
    expect(corroboratesLidarrHit('Something', hit(''))).toBe(false);
  });
});
