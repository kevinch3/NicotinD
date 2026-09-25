import { describe, expect, it } from 'bun:test';
import {
  sanitizeSegment,
  isPhantomMatch,
  trackNumberPrefix,
  isMultiDiscRelease,
  parseOrganizerStem,
  leadingTrackKey,
  stripAudioExt,
  stripTrackPrefix,
  isTrackNumberFragment,
  looksLikeFilenameTag,
  stripArtistLeadJunk,
  stripFeaturingSuffix,
} from './path-sanitize.js';

describe('sanitizeSegment', () => {
  it('replaces illegal filesystem characters with a space', () => {
    expect(sanitizeSegment('AC/DC')).toBe('AC DC');
    expect(sanitizeSegment('a<b>c:d"e|f?g*h\\i/j')).toBe('a b c d e f g h i j');
  });

  it('collapses consecutive whitespace into single spaces', () => {
    expect(sanitizeSegment('Foo   bar\t\tbaz')).toBe('Foo bar baz');
  });

  it('strips trailing dots (Windows / Navidrome friendliness)', () => {
    expect(sanitizeSegment('Artist.')).toBe('Artist');
    expect(sanitizeSegment('Album...')).toBe('Album');
  });

  it('NFC-normalizes combining characters', () => {
    const decomposed = 'Café'; // "Café" as NFD
    const result = sanitizeSegment(decomposed);
    expect(result).toBe('Café'.normalize('NFC'));
    expect(result.length).toBe(4); // 'Café' is 4 chars in NFC, 5 in NFD
  });

  it('caps at maxLen and re-trims trailing whitespace', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeSegment(long).length).toBe(180);
    expect(sanitizeSegment('a'.repeat(180) + ' b')).toBe('a'.repeat(180));
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeSegment('')).toBe('');
  });
});

describe('isPhantomMatch', () => {
  it('is true only for exact basename equality', () => {
    expect(isPhantomMatch('song.mp3', 'song.mp3')).toBe(true);
    expect(isPhantomMatch('song.mp3', 'Song.mp3')).toBe(false);
  });
});

describe('trackNumberPrefix', () => {
  it('formats a positive number as zero-padded 2-digit prefix', () => {
    expect(trackNumberPrefix(1)).toBe('01 - ');
    expect(trackNumberPrefix(12)).toBe('12 - ');
  });

  it('returns empty string for undefined / non-positive / non-finite', () => {
    expect(trackNumberPrefix(undefined)).toBe('');
    expect(trackNumberPrefix(0)).toBe('');
    expect(trackNumberPrefix(-3)).toBe('');
    expect(trackNumberPrefix(Number.NaN)).toBe('');
  });
});

describe('stripAudioExt', () => {
  it('removes trailing audio extensions', () => {
    expect(stripAudioExt('song.mp3')).toBe('song');
    expect(stripAudioExt('song.FLAC')).toBe('song');
    expect(stripAudioExt('song.opus')).toBe('song');
  });

  it('leaves non-audio extensions and bare names alone', () => {
    expect(stripAudioExt('readme.txt')).toBe('readme.txt');
    expect(stripAudioExt('plain')).toBe('plain');
  });
});

describe('stripTrackPrefix', () => {
  it('strips the leading track number with whitespace after the separator', () => {
    expect(stripTrackPrefix('01. Hello')).toBe('Hello');
    expect(stripTrackPrefix('3) World')).toBe('World');
    expect(stripTrackPrefix('04 - Track')).toBe('Track');
    expect(stripTrackPrefix('05 _ Track')).toBe('Track');
  });

  it('strips "NN-Title" / "NN_Title" without whitespace around the separator', () => {
    expect(stripTrackPrefix('5_Track')).toBe('Track');
    expect(stripTrackPrefix('01-Demasiado')).toBe('Demasiado');
    expect(stripTrackPrefix('07.Title')).toBe('Title');
  });

  it('leaves plain values alone', () => {
    expect(stripTrackPrefix('Plain Title')).toBe('Plain Title');
    expect(stripTrackPrefix('1989')).toBe('1989'); // no separator
  });
});

describe('isTrackNumberFragment', () => {
  it('is true for bare track-number-shaped values', () => {
    expect(isTrackNumberFragment('01')).toBe(true);
    expect(isTrackNumberFragment('01.')).toBe(true);
    expect(isTrackNumberFragment(' 006')).toBe(true);
  });

  it('is false when there is non-numeric content after the number', () => {
    expect(isTrackNumberFragment('01 Track')).toBe(false);
  });

  it('is false for numbers wider than 3 digits (real album names like "1989")', () => {
    expect(isTrackNumberFragment('1989')).toBe(false);
  });
});

describe('looksLikeFilenameTag', () => {
  it('is true for values ending in an audio extension', () => {
    expect(looksLikeFilenameTag('01 - Track.mp3')).toBe(true);
    expect(looksLikeFilenameTag('song.flac')).toBe(true);
  });

  it('is true for values starting with a track-number prefix', () => {
    expect(looksLikeFilenameTag('01 - Track')).toBe(true);
    expect(looksLikeFilenameTag('3) Title')).toBe(true);
  });

  it('is false for real album names', () => {
    expect(looksLikeFilenameTag('1989')).toBe(false);
    expect(looksLikeFilenameTag('Discovery')).toBe(false);
  });

  it('is false for empty input', () => {
    expect(looksLikeFilenameTag('')).toBe(false);
  });
});

describe('stripArtistLeadJunk', () => {
  it('strips leading orphan punctuation and featuring-prefixes', () => {
    expect(stripArtistLeadJunk('& Peter Tosh')).toBe('Peter Tosh');
    expect(stripArtistLeadJunk(', Recondite')).toBe('Recondite');
    expect(stripArtistLeadJunk('feat. Solomun')).toBe('Solomun');
    expect(stripArtistLeadJunk('featuring Bono')).toBe('Bono');
  });

  it('loops until stable', () => {
    expect(stripArtistLeadJunk('&, feat. X')).toBe('X');
  });

  it('leaves plain artist values alone', () => {
    expect(stripArtistLeadJunk('Plain Artist')).toBe('Plain Artist');
  });
});

describe('stripFeaturingSuffix', () => {
  it('strips trailing "feat. <name>"', () => {
    expect(stripFeaturingSuffix('Daft Punk feat. Pharrell')).toBe('Daft Punk');
  });

  it('strips trailing "ft <name>" without the period', () => {
    expect(stripFeaturingSuffix('Artist ft Bono')).toBe('Artist');
    expect(stripFeaturingSuffix('Artist ft. Bono')).toBe('Artist');
  });

  it('strips parenthesized featuring blocks', () => {
    expect(stripFeaturingSuffix('Artist (feat. X)')).toBe('Artist');
    expect(stripFeaturingSuffix('Artist (ft. X & Y)')).toBe('Artist');
  });

  it('strips bracketed featuring blocks', () => {
    expect(stripFeaturingSuffix('Artist [ft. Y]')).toBe('Artist');
  });

  it('strips "with" and "w/" trailing collaborators', () => {
    expect(stripFeaturingSuffix('Artist w/ Foo')).toBe('Artist');
    expect(stripFeaturingSuffix('Bob with Joy Inc')).toBe('Bob');
  });

  it('is case-insensitive', () => {
    expect(stripFeaturingSuffix('Artist FEATURING X')).toBe('Artist');
    expect(stripFeaturingSuffix('Artist FEAT. X')).toBe('Artist');
  });

  it('leaves plain artist values unchanged', () => {
    expect(stripFeaturingSuffix('Plain Artist')).toBe('Plain Artist');
  });

  it('preserves "&" and "/" inside the artist name (legitimate band names)', () => {
    expect(stripFeaturingSuffix('Daft Punk & Pharrell')).toBe('Daft Punk & Pharrell');
    expect(stripFeaturingSuffix('AC/DC')).toBe('AC/DC');
    expect(stripFeaturingSuffix('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
  });

  it('does not strip "feat" appearing at the start of the value', () => {
    expect(stripFeaturingSuffix('Featured Performers')).toBe('Featured Performers');
  });

  it('does not strip "feat." when no credit follows', () => {
    expect(stripFeaturingSuffix('Artist feat.')).toBe('Artist feat.');
  });

  it('tidies trailing punctuation residue', () => {
    expect(stripFeaturingSuffix('Artist, feat. X')).toBe('Artist');
    expect(stripFeaturingSuffix('Artist - feat. X')).toBe('Artist');
  });

  it('returns empty input unchanged', () => {
    expect(stripFeaturingSuffix('')).toBe('');
  });
});

// Issue #747: the disc lives in the filename, and only on a multi-disc release.
describe('trackNumberPrefix with a disc', () => {
  it('prefixes D-NN when a disc is given', () => {
    expect(trackNumberPrefix(1, 2)).toBe('2-01 - ');
    expect(trackNumberPrefix(12, 1)).toBe('1-12 - ');
  });

  it('keeps NN when no disc is given (single-disc albums never re-mint)', () => {
    expect(trackNumberPrefix(1, undefined)).toBe('01 - ');
    expect(trackNumberPrefix(1, 0)).toBe('01 - ');
  });

  it('adds nothing without a track number, disc or not', () => {
    expect(trackNumberPrefix(undefined, 2)).toBe('');
  });
});

describe('isMultiDiscRelease', () => {
  it('is false for no disc tags, a bare 1, and 1 of 1', () => {
    expect(isMultiDiscRelease([{}, {}])).toBe(false);
    expect(isMultiDiscRelease([{ discNumber: 1 }])).toBe(false);
    expect(isMultiDiscRelease([{ discNumber: 1, discTotal: 1 }])).toBe(false);
  });

  it('is true when any track is on a disc above 1', () => {
    expect(isMultiDiscRelease([{ discNumber: 1 }, { discNumber: 2 }])).toBe(true);
  });

  it('is true for disc 1 alone when its total says more discs exist', () => {
    expect(isMultiDiscRelease([{ discNumber: 1, discTotal: 2 }])).toBe(true);
  });
});

describe('parseOrganizerStem', () => {
  it('parses both organizer shapes', () => {
    expect(parseOrganizerStem('05 - Title')).toEqual({ track: 5, title: 'Title' });
    expect(parseOrganizerStem('2-05 - Title')).toEqual({ disc: 2, track: 5, title: 'Title' });
  });

  it('keeps a leading number that belongs to the title (#1089)', () => {
    expect(parseOrganizerStem('11 - 7 Steps')).toEqual({ track: 11, title: '7 Steps' });
    expect(parseOrganizerStem('1-11 - 7 Steps')).toEqual({ disc: 1, track: 11, title: '7 Steps' });
  });

  it('returns null for any other shape', () => {
    expect(parseOrganizerStem('Artist - Title')).toBeNull();
    expect(parseOrganizerStem('1989')).toBeNull();
    expect(parseOrganizerStem('2021 - Title')).toBeNull();
  });
});

describe('leadingTrackKey', () => {
  it('keeps the disc in a D-NN name so two discs never share a group', () => {
    expect(leadingTrackKey('1-01 - Intro.mp3')).toBe('1-01');
    expect(leadingTrackKey('2-01 - Intro.flac')).toBe('2-01');
  });

  it('is the leading digits otherwise, and null without them', () => {
    expect(leadingTrackKey('01 - Intro.mp3')).toBe('01');
    expect(leadingTrackKey('01-Intro.mp3')).toBe('01');
    expect(leadingTrackKey('Intro.mp3')).toBeNull();
  });
});
