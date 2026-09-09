import { describe, expect, it } from 'bun:test';
import type { AddonAlbumCandidate } from '@nicotind/core';
import { coveredTitles, rankAlternates } from './download-resource.js';

function candidate(over: Partial<AddonAlbumCandidate> = {}): AddonAlbumCandidate {
  return {
    candidateRef: 'ref-1',
    username: 'peer',
    directory: 'Music\\Luis Miguel\\Romances',
    matchedTracks: 2,
    totalTracks: 2,
    matchPct: 100,
    format: 'FLAC',
    estimatedSizeMb: 300,
    isLive: false,
    files: [
      { filename: 'Music\\Luis Miguel\\Romances\\01 Amanecer.flac', size: 1 },
      { filename: 'Music\\Luis Miguel\\Romances\\02 Besame mucho.flac', size: 1 },
    ],
    ...over,
  };
}

describe('coveredTitles', () => {
  it('matches a peer file to the canonical title through accents and track numbers', () => {
    // The peer's file is unaccented and numbered; the tracklist is neither.
    // Anything less than the shared folding matcher misses this, which in a
    // Latin-American library is most of the catalogue.
    expect(coveredTitles(['Amanecer', 'Bésame mucho'], candidate())).toEqual([
      'Amanecer',
      'Bésame mucho',
    ]);
  });

  it('reports only what the peer actually offers', () => {
    expect(coveredTitles(['Amanecer', 'Contigo', 'El reloj'], candidate())).toEqual(['Amanecer']);
  });

  it('counts a title once even when the folder holds several encodes of it', () => {
    const c = candidate({
      files: [
        { filename: 'Amanecer.flac', size: 1 },
        { filename: 'Amanecer.mp3', size: 1 },
        { filename: '01 - Amanecer (remaster).flac', size: 1 },
      ],
    });
    expect(coveredTitles(['Amanecer'], c)).toEqual(['Amanecer']);
  });

  it('offers nothing for a candidate that has none of the wanted tracks', () => {
    expect(coveredTitles(['Uno', 'El reloj'], candidate())).toEqual([]);
  });
});

describe('rankAlternates', () => {
  const wanted = ['Amanecer', 'Bésame mucho'];

  it('excludes the peers the job is already waiting on', () => {
    // The whole point of the feature: an "alternate" that is the peer we are
    // already stuck behind is the same dead end.
    const out = rankAlternates(wanted, [candidate({ username: 'stuck-peer' })], ['stuck-peer']);
    expect(out).toEqual([]);
  });

  it('drops candidates that cover none of the wanted tracks', () => {
    const useless = candidate({
      username: 'other',
      candidateRef: 'ref-2',
      files: [{ filename: 'Some Other Album\\01 Uno.flac', size: 1 }],
    });
    expect(rankAlternates(wanted, [useless]).map((a) => a.username)).toEqual([]);
  });

  it('ranks coverage above availability', () => {
    const broad = candidate({ username: 'broad', candidateRef: 'a', freeUploadSlots: 0 });
    const fastButThin = candidate({
      username: 'thin',
      candidateRef: 'b',
      freeUploadSlots: 9,
      files: [{ filename: '01 Amanecer.flac', size: 1 }],
    });
    expect(rankAlternates(wanted, [fastButThin, broad]).map((a) => a.username)).toEqual([
      'broad',
      'thin',
    ]);
  });

  it('breaks a coverage tie on availability, which is what was actually wrong', () => {
    // #1065's card sat at 0 of 14 for ten hours behind a peer with no free
    // slots. Every other signal said that peer was fine.
    const noSlots = candidate({ username: 'busy', candidateRef: 'a', freeUploadSlots: 0 });
    const free = candidate({ username: 'free', candidateRef: 'b', freeUploadSlots: 3 });
    expect(rankAlternates(wanted, [noSlots, free]).map((a) => a.username)).toEqual([
      'free',
      'busy',
    ]);
  });

  it('does not rank on format — the picker shows it and the person decides', () => {
    const mp3 = candidate({
      username: 'mp3peer',
      candidateRef: 'a',
      format: 'MP3',
      freeUploadSlots: 5,
    });
    const flac = candidate({
      username: 'flacpeer',
      candidateRef: 'b',
      format: 'FLAC',
      freeUploadSlots: 1,
    });
    const out = rankAlternates(wanted, [flac, mp3]);
    expect(out.map((a) => a.username)).toEqual(['mp3peer', 'flacpeer']);
    expect(out.map((a) => a.format)).toEqual(['MP3', 'FLAC']);
  });

  it('carries the covered titles so the caller asks for exactly those', () => {
    const partial = candidate({
      username: 'partial',
      files: [{ filename: '02 Besame mucho.flac', size: 1 }],
    });
    expect(rankAlternates(wanted, [partial])[0]!.coveredTitles).toEqual(['Bésame mucho']);
  });
});
