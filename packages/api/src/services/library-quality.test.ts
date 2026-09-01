import { describe, it, expect } from 'bun:test';
import {
  looksLikeSourceWatermark,
  isNumericLikeName,
  looksLikeDjSetTag,
  looksLikeVenueCredit,
  djSetArtistName,
  findArtistFragmentClusters,
} from './library-quality.js';

describe('looksLikeSourceWatermark', () => {
  it('flags bare-domain watermarks seen in the prod library', () => {
    expect(looksLikeSourceWatermark('ftpdjemilio.com')).toBe(true);
    expect(looksLikeSourceWatermark('MUSICAUNO.COM')).toBe(true);
    expect(looksLikeSourceWatermark('www.somepool.net')).toBe(true);
  });

  it('flags DJ-pool / batea source keywords', () => {
    expect(looksLikeSourceWatermark('DJ KAIRUZ- SERVICIO ARG')).toBe(true);
    expect(looksLikeSourceWatermark('Batea Especial Casamientos + 50 Años')).toBe(true);
  });

  it('does not flag legitimate artists (incl. bare "DJ" prefix)', () => {
    expect(looksLikeSourceWatermark('DJ Snake')).toBe(false);
    expect(looksLikeSourceWatermark('Soda Stereo')).toBe(false);
    expect(looksLikeSourceWatermark('Calle 13')).toBe(false);
    expect(looksLikeSourceWatermark('blink-182')).toBe(false);
    expect(looksLikeSourceWatermark('')).toBe(false);
    expect(looksLikeSourceWatermark(undefined)).toBe(false);
  });
});

describe('isNumericLikeName', () => {
  it('flags bare numbers and disc-track shapes (mis-parsed tags)', () => {
    expect(isNumericLikeName('101')).toBe(true);
    expect(isNumericLikeName('208')).toBe(true);
    expect(isNumericLikeName('12')).toBe(true);
    expect(isNumericLikeName('07.')).toBe(true);
    expect(isNumericLikeName('02-03')).toBe(true);
    expect(isNumericLikeName('03,4,5,6')).toBe(true);
  });

  it('flags any bare number incl. 4-digit (context protects real album titles)', () => {
    // The raw predicate flags "1989" too; the auditor only treats a numeric value
    // as pollution when it's an ARTIST name, or an album title on a single-track
    // album — so legit numeric album titles like "1989"/"21" are never deleted.
    expect(isNumericLikeName('1989')).toBe(true);
    expect(isNumericLikeName('21')).toBe(true);
  });

  it('does not flag names containing letters', () => {
    expect(isNumericLikeName('Calle 13')).toBe(false);
    expect(isNumericLikeName('Maroon 5')).toBe(false);
    expect(isNumericLikeName('1000 Forms of Fear')).toBe(false);
    expect(isNumericLikeName('')).toBe(false);
    expect(isNumericLikeName(undefined)).toBe(false);
  });
});

// Issue #679. The positive cases are the actual shapes a curation session had to
// undo by hand with 7 merges (a techno/Drumcode-adjacent download batch); the
// negative cases are the real names a looser regex would have eaten.
describe('looksLikeDjSetTag', () => {
  it('flags a set tracklist line — narration verb next to a quoted title', () => {
    expect(looksLikeDjSetTag('Adam Beyer plays Enrico Sangiuliano "Biomorph"')).toBe(true);
    expect(looksLikeDjSetTag('Charlotte de Witte playing "Doppler" @ Tomorrowland')).toBe(true);
  });

  it('flags a back-to-back credit between two acts', () => {
    expect(looksLikeDjSetTag('Secret Cinema B2B Egbert')).toBe(true);
    expect(looksLikeDjSetTag('Adam Beyer b2b Ida Engberg')).toBe(true);
  });

  it('flags a release-listing row (3+ " - " separators)', () => {
    expect(looksLikeDjSetTag('Enrico Sangiuliano - Biomorph - Drumcode - DC190 [Vol')).toBe(true);
  });

  it('does not flag a single " - ", which a real name can carry', () => {
    // Unrecoverable without already knowing the artist — guessing here would
    // corrupt more than it fixes, so it is deliberately left alone.
    expect(looksLikeDjSetTag('Enrico Sangiuliano - Biomorph')).toBe(false);
    expect(looksLikeDjSetTag('Emerson, Lake - Palmer')).toBe(false);
  });

  it('does not flag real artist and album names', () => {
    expect(looksLikeDjSetTag('blink-182')).toBe(false);
    expect(looksLikeDjSetTag('Jean-Michel Jarre')).toBe(false);
    expect(looksLikeDjSetTag('Godspeed You! Black Emperor')).toBe(false);
    expect(looksLikeDjSetTag('Sgt. Pepper’s Lonely Hearts Club Band')).toBe(false);
    expect(looksLikeDjSetTag('The Beatles')).toBe(false);
    expect(looksLikeDjSetTag('')).toBe(false);
    expect(looksLikeDjSetTag(undefined)).toBe(false);
  });

  it('does not flag a quoted title with no narration verb', () => {
    expect(looksLikeDjSetTag('Weird Al "Yankovic"')).toBe(false);
  });

  it('leaves the venue shape to looksLikeVenueCredit (a real album uses it)', () => {
    expect(looksLikeDjSetTag('Live @ Wembley')).toBe(false);
  });
});

describe('looksLikeVenueCredit (artist field only)', () => {
  it('flags a venue/date credit', () => {
    expect(looksLikeVenueCredit('Enrico Sangiuliano @ Awakenings')).toBe(true);
    expect(looksLikeVenueCredit('Amelie Lens @ Fuse, 2019')).toBe(true);
    // Why it is artist-only: as an ALBUM title this is a real live release.
    expect(looksLikeVenueCredit('Live @ Wembley')).toBe(true);
  });

  it('does not flag a name without a spaced @', () => {
    expect(looksLikeVenueCredit('Enrico Sangiuliano')).toBe(false);
    expect(looksLikeVenueCredit('@venue')).toBe(false);
    expect(looksLikeVenueCredit('')).toBe(false);
    expect(looksLikeVenueCredit(undefined)).toBe(false);
  });
});

describe('djSetArtistName', () => {
  it('recovers the leading credit from a venue line', () => {
    expect(djSetArtistName('Enrico Sangiuliano @ Awakenings')).toBe('Enrico Sangiuliano');
    expect(djSetArtistName('Amelie Lens @ Fuse, 2019')).toBe('Amelie Lens');
  });

  it('recovers the DJ from a set tracklist line', () => {
    expect(djSetArtistName('Adam Beyer plays Enrico Sangiuliano "Biomorph"')).toBe('Adam Beyer');
  });

  it('recovers the artist from a release-listing row', () => {
    expect(djSetArtistName('Enrico Sangiuliano - Biomorph - Drumcode - DC190 [Vol')).toBe(
      'Enrico Sangiuliano',
    );
  });

  it('refuses to guess on a b2b credit — two acts, no basis for picking one', () => {
    expect(djSetArtistName('Secret Cinema B2B Egbert playing "Biomorph"')).toBeNull();
    expect(djSetArtistName('Adam Beyer b2b Ida Engberg @ Awakenings')).toBeNull();
  });

  it('returns null when there is nothing to recover', () => {
    expect(djSetArtistName('Enrico Sangiuliano')).toBeNull();
    expect(djSetArtistName('Enrico Sangiuliano - Biomorph')).toBeNull();
    expect(djSetArtistName('')).toBeNull();
    expect(djSetArtistName(undefined)).toBeNull();
  });

  it('rejects a lead that is too long to be a name, or is itself junk', () => {
    expect(djSetArtistName('this is a very long sentence fragment indeed @ Venue')).toBeNull();
    expect(djSetArtistName('ftpdjemilio.com @ Awakenings')).toBeNull();
    expect(djSetArtistName('101 @ Awakenings')).toBeNull();
  });
});

describe('findArtistFragmentClusters', () => {
  // The real prod population that motivated the rule (issue #864).
  const SANAMPAY = [
    'Sanampay',
    'Sanampay, V. PARRA',
    'Sanampay, CH. BUARQUE',
    'Sanampay, D.P.',
    'Sanampay, J.C. COBIÁN - E. CADICAMO',
  ];

  it('clusters per-track credit rows under the base artist they extend', () => {
    const clusters = findArtistFragmentClusters(SANAMPAY, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.base).toBe('Sanampay');
    expect(clusters[0]!.fragments).toHaveLength(4);
  });

  it('needs the base to exist as its own row — a lone compound is not a cluster', () => {
    expect(findArtistFragmentClusters(['Sanampay, V. PARRA', 'Sanampay, D.P.'], 2)).toEqual([]);
  });

  it('matches the base accent- and case-insensitively', () => {
    const clusters = findArtistFragmentClusters(
      [
        'Los Ángeles Azules',
        'Los Angeles Azules, Ximena Sariñana',
        'LOS ÁNGELES AZULES, Nicki Nicole',
      ],
      2,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.fragments).toHaveLength(2);
  });

  it('honours minFragments so a caller can trade recall for quiet', () => {
    expect(findArtistFragmentClusters(SANAMPAY, 5)).toEqual([]);
    expect(findArtistFragmentClusters(SANAMPAY, 4)).toHaveLength(1);
  });

  it('reports the root of a chain once, not the same rows under every prefix', () => {
    const clusters = findArtistFragmentClusters(['A', 'A, B', 'A, B, C', 'A, B, D', 'A, E'], 2);
    expect(clusters.map((c) => c.base)).toEqual(['A']);
  });

  it('does not treat an unrelated name sharing a word prefix as a fragment', () => {
    // "Sanampay Trio" extends the *string* but not the "<base>, " credit shape.
    expect(findArtistFragmentClusters(['Sanampay', 'Sanampay Trio', 'Sanampayasos'], 2)).toEqual(
      [],
    );
  });
});
