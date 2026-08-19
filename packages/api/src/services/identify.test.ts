/**
 * Policy tests for buildIdentifyApplyTags: empty/placeholder strings and
 * out-of-range numbers are ignored (never clear an existing tag); MBID fields
 * map onto their tag names; an all-junk body yields null so the route 400s.
 */
import { describe, expect, it } from 'bun:test';
import { buildIdentifyApplyTags } from './identify.js';

describe('buildIdentifyApplyTags', () => {
  it('maps every field, renaming the MBID keys onto their tag names', () => {
    expect(
      buildIdentifyApplyTags({
        title: 'T',
        artist: 'A',
        album: 'Al',
        albumArtist: 'AA',
        year: 2001,
        trackNumber: 3,
        acoustId: 'ac',
        recordingId: 'rec',
        releaseId: 'rel',
      }),
    ).toEqual({
      title: 'T',
      artist: 'A',
      album: 'Al',
      albumArtist: 'AA',
      year: 2001,
      trackNumber: 3,
      acoustIdId: 'ac',
      mbRecordingId: 'rec',
      mbReleaseId: 'rel',
    });
  });

  it('ignores empty, whitespace-only, and placeholder strings rather than clearing', () => {
    expect(
      buildIdentifyApplyTags({
        title: '',
        artist: '  ',
        album: 'Unknown Album',
        albumArtist: 'AA',
      }),
    ).toEqual({ albumArtist: 'AA' });
  });

  it('ignores an out-of-range or non-integer year', () => {
    expect(buildIdentifyApplyTags({ title: 'T', year: 123 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', year: 2101 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', year: 2001.5 })).toEqual({ title: 'T' });
  });

  it('ignores a non-positive or non-integer track number', () => {
    expect(buildIdentifyApplyTags({ title: 'T', trackNumber: 0 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', trackNumber: 2.5 })).toEqual({ title: 'T' });
  });

  it('returns null when nothing survives the policy', () => {
    expect(buildIdentifyApplyTags({})).toBeNull();
    expect(buildIdentifyApplyTags({ title: '', year: 123 })).toBeNull();
  });
});
