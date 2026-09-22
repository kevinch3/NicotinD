import { describe, expect, it } from 'bun:test';
import { planVorbisKeyFixes, UNMODELLED_SPACED_KEYS } from './vorbis-keys.js';

const c = (id: string, value: unknown) => ({ id, value });

describe('planVorbisKeyFixes (#1250, #1231)', () => {
  it('moves a lone spaced key to its canonical name and deletes the spaced one', () => {
    expect(planVorbisKeyFixes([c('MUSICBRAINZ ARTIST ID', 'a1')])).toEqual({
      metadata: ['MUSICBRAINZ_ARTISTID=a1', 'MUSICBRAINZ ARTIST ID='],
      conflicts: [],
    });
  });

  it('matches ids case-insensitively, as ffmpeg and taggers disagree on case', () => {
    expect(planVorbisKeyFixes([c('MusicBrainz Album Type', 'album')]).metadata).toEqual([
      'RELEASETYPE=album',
      'MUSICBRAINZ ALBUM TYPE=',
    ]);
  });

  it("writes the album artist under ffmpeg's generic key, not the Vorbis spelling (#914)", () => {
    expect(planVorbisKeyFixes([c('ALBUM ARTIST', 'X')]).metadata).toEqual([
      'album_artist=X',
      'ALBUM ARTIST=',
    ]);
  });

  it('only deletes the spaced key when the canonical one already agrees', () => {
    const plan = planVorbisKeyFixes([c('ALBUMARTIST', 'Same '), c('ALBUM ARTIST', 'Same')]);
    expect(plan).toEqual({ metadata: ['ALBUM ARTIST='], conflicts: [] });
  });

  it('changes nothing and reports it when the two disagree', () => {
    const plan = planVorbisKeyFixes([c('ALBUMARTIST', 'A'), c('ALBUM ARTIST', 'B')]);
    expect(plan).toEqual({
      metadata: [],
      conflicts: [{ spaced: 'ALBUM ARTIST', canonical: 'ALBUMARTIST' }],
    });
  });

  it('deletes the spaced key whatever it says when this write sets the field itself', () => {
    const plan = planVorbisKeyFixes([c('ALBUMARTIST', 'A'), c('ALBUM ARTIST', 'B')], {
      written: new Set(['ALBUM_ARTIST']),
    });
    expect(plan).toEqual({ metadata: ['ALBUM ARTIST='], conflicts: [] });
  });

  it('reports a multi-valued spaced key rather than keeping only its first value', () => {
    const plan = planVorbisKeyFixes([
      c('MUSICBRAINZ ARTIST ID', 'a1'),
      c('MUSICBRAINZ ARTIST ID', 'a2'),
    ]);
    expect(plan.metadata).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it('compares a second spaced name against the value the first one moved', () => {
    const keys = [
      { spaced: 'A ONE', canonical: 'SHARED', ffmpegKey: 'SHARED' },
      { spaced: 'A TWO', canonical: 'SHARED', ffmpegKey: 'SHARED' },
    ];
    const agree = planVorbisKeyFixes([c('A ONE', 'x'), c('A TWO', 'x')], { keys });
    expect(agree.metadata).toEqual(['SHARED=x', 'A ONE=', 'A TWO=']);
    const differ = planVorbisKeyFixes([c('A ONE', 'x'), c('A TWO', 'y')], { keys });
    expect(differ.conflicts).toEqual([{ spaced: 'A TWO', canonical: 'SHARED' }]);
  });

  it('treats values differing only in case as agreeing, keeping the canonical one (#1283)', () => {
    expect(
      planVorbisKeyFixes([c('RELEASETYPE', 'album'), c('MUSICBRAINZ ALBUM TYPE', 'Album')]),
    ).toEqual({
      metadata: ['MUSICBRAINZ ALBUM TYPE='],
      conflicts: [],
    });
  });

  it('does not map RELEASE TYPE, which holds edition labels, not release types (#1283)', () => {
    expect(planVorbisKeyFixes([c('RELEASE TYPE', 'Limited')])).toEqual({
      metadata: [],
      conflicts: [],
    });
  });

  it('puts an edition label filed as RELEASETYPE back under RELEASE TYPE (#1283)', () => {
    expect(planVorbisKeyFixes([c('RELEASETYPE', 'Retail')])).toEqual({
      metadata: ['RELEASE TYPE=Retail', 'RELEASETYPE='],
      conflicts: [],
    });
    // Real release types, and release-type-shaped values other taggers wrote, stay.
    for (const v of ['album', 'Album', 'compilation;album', 'Album (Reissue)', 'LP, Album'])
      expect(planVorbisKeyFixes([c('RELEASETYPE', v)]).metadata).toEqual([]);
    // Already has a RELEASE TYPE: nothing to restore into.
    expect(
      planVorbisKeyFixes([c('RELEASETYPE', 'Retail'), c('RELEASE TYPE', 'Limited')]).metadata,
    ).toEqual([]);
  });

  it('settles a disagreement the way a curator decided (#1283)', () => {
    const pair = [c('ALBUMARTIST', 'Cultura Profetica'), c('ALBUM ARTIST', 'Cultura Profética')];
    expect(
      planVorbisKeyFixes(pair, { prefer: new Map([['ALBUM ARTIST', 'spaced']]) }).metadata,
    ).toEqual(['album_artist=Cultura Profética', 'ALBUM ARTIST=']);
    expect(
      planVorbisKeyFixes(pair, { prefer: new Map([['ALBUM ARTIST', 'canonical']]) }).metadata,
    ).toEqual(['ALBUM ARTIST=']);
    // A preference for a different key leaves this pair a conflict.
    expect(
      planVorbisKeyFixes(pair, { prefer: new Map([['MUSICBRAINZ ALBUM ID', 'spaced']]) }).conflicts,
    ).toHaveLength(1);
  });

  it('leaves keys outside the table, and non-string values, alone', () => {
    expect(planVorbisKeyFixes([c('RIP DATE', '2001'), c('ALBUM ARTIST', { x: 1 })])).toEqual({
      metadata: [],
      conflicts: [],
    });
  });

  it('can be limited to a subset of the table', () => {
    const plan = planVorbisKeyFixes([c('ACOUSTID ID', 'x'), c('MUSICBRAINZ ARTIST ID', 'a1')], {
      keys: UNMODELLED_SPACED_KEYS,
    });
    expect(plan.metadata).toEqual(['MUSICBRAINZ_ARTISTID=a1', 'MUSICBRAINZ ARTIST ID=']);
  });
});
