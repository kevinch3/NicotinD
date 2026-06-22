import { describe, expect, it } from 'bun:test';
import {
  archiveToCandidate,
  spotifyToCandidate,
  mergeCandidates,
  rankCandidates,
  sourceLabel,
  type AcquisitionCandidate,
} from './acquisition-candidate.js';

const slskdFolder = (over: Partial<AcquisitionCandidate> = {}): AcquisitionCandidate => ({
  source: 'soulseek',
  sourceLabel: 'Soulseek',
  kind: 'folder',
  title: 'Porfiado',
  artist: 'El Cuarteto de Nos',
  format: 'FLAC',
  score: 100,
  availability: { freeSlots: 1, queueLength: 0 },
  acquire: { via: 'enqueue', sourceRef: 'peer1', files: [{ filename: 'a/01.flac', size: 1 }] },
  ...over,
});

describe('sourceLabel', () => {
  it('maps known sources and falls back to the id', () => {
    expect(sourceLabel('soulseek')).toBe('Soulseek');
    expect(sourceLabel('archive')).toBe('Internet Archive');
    expect(sourceLabel('spotify')).toBe('Spotify');
    expect(sourceLabel('bandcamp')).toBe('bandcamp');
  });
});

describe('archiveToCandidate', () => {
  it('maps an archive item to a url-acquire candidate', () => {
    const c = archiveToCandidate({
      identifier: 'porfiado',
      title: 'Porfiado',
      creator: 'El Cuarteto de Nos',
      year: '2012',
      detailsUrl: 'https://archive.org/details/porfiado',
      trackCount: 12,
      kind: 'album',
    });
    expect(c.source).toBe('archive');
    expect(c.sourceLabel).toBe('Internet Archive');
    expect(c.kind).toBe('album');
    expect(c.year).toBe(2012);
    expect(c.trackCount).toBe(12);
    expect(c.acquire).toEqual({ via: 'url', url: 'https://archive.org/details/porfiado' });
  });

  it('treats a single kind and missing year/creator gracefully', () => {
    const c = archiveToCandidate({
      identifier: 'x',
      title: 'X',
      creator: '',
      year: null,
      detailsUrl: 'https://archive.org/details/x',
      kind: 'single',
    });
    expect(c.kind).toBe('single');
    expect(c.year).toBeUndefined();
    expect(c.artist).toBeUndefined();
  });
});

describe('spotifyToCandidate', () => {
  it('maps a spotify album to a url-acquire candidate carrying the cover', () => {
    const c = spotifyToCandidate({
      id: 'abc',
      url: 'https://open.spotify.com/album/abc',
      title: 'Porfiado',
      artist: 'El Cuarteto de Nos',
      year: '2012',
      coverUrl: 'https://img/cover.jpg',
      trackCount: 12,
      kind: 'album',
    });
    expect(c.source).toBe('spotify');
    expect(c.coverUrl).toBe('https://img/cover.jpg');
    expect(c.acquire).toEqual({ via: 'url', url: 'https://open.spotify.com/album/abc' });
  });
});

describe('rankCandidates', () => {
  it('orders by score, then lossless format, then availability', () => {
    const low = slskdFolder({ title: 'low', score: 40 });
    const high = slskdFolder({ title: 'high', score: 90 });
    const ranked = rankCandidates([low, high]);
    expect(ranked.map((c) => c.title)).toEqual(['high', 'low']);
  });

  it('prefers FLAC over lossy at equal score', () => {
    const mp3 = slskdFolder({ title: 'mp3', format: 'MP3 320kbps', score: 80 });
    const flac = slskdFolder({ title: 'flac', format: 'FLAC', score: 80 });
    expect(rankCandidates([mp3, flac]).map((c) => c.title)).toEqual(['flac', 'mp3']);
  });

  it('prefers an available peer over a queued one at equal score/format', () => {
    const queued = slskdFolder({ title: 'queued', availability: { freeSlots: 0 }, score: 80 });
    const free = slskdFolder({ title: 'free', availability: { freeSlots: 2 }, score: 80 });
    expect(rankCandidates([queued, free]).map((c) => c.title)).toEqual(['free', 'queued']);
  });
});

describe('mergeCandidates', () => {
  it('blends sources into one ranked list', () => {
    const slskd = slskdFolder({ score: 100 });
    const archive = archiveToCandidate({
      identifier: 'p',
      title: 'Porfiado',
      creator: 'El Cuarteto de Nos',
      year: '2012',
      detailsUrl: 'https://archive.org/details/p',
      trackCount: 12,
      kind: 'album',
    });
    const merged = mergeCandidates([slskd], [archive]);
    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('soulseek'); // higher score first
  });

  it('de-dupes the same acquire target, keeping the higher score', () => {
    const a = slskdFolder({ score: 50 });
    const b = slskdFolder({ score: 95 });
    const merged = mergeCandidates([a], [b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(95);
  });

  it('keeps distinct url targets from the same source', () => {
    const one = archiveToCandidate({
      identifier: '1',
      title: 'One',
      creator: 'A',
      year: null,
      detailsUrl: 'https://archive.org/details/1',
    });
    const two = archiveToCandidate({
      identifier: '2',
      title: 'Two',
      creator: 'A',
      year: null,
      detailsUrl: 'https://archive.org/details/2',
    });
    expect(mergeCandidates([one, two])).toHaveLength(2);
  });
});
