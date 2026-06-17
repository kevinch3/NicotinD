import { describe, it, expect } from 'vitest';
import { buildMediaMetadata, ARTWORK_SIZES } from './media-metadata';

const coverUrl = (coverArt: string, size: number) =>
  `https://srv/api/cover/${coverArt}?size=${size}`;

describe('buildMediaMetadata', () => {
  it('maps title/artist/album', () => {
    const m = buildMediaMetadata({ title: 'T', artist: 'A', album: 'Alb' }, coverUrl);
    expect(m.title).toBe('T');
    expect(m.artist).toBe('A');
    expect(m.album).toBe('Alb');
  });

  it('defaults a missing album to an empty string', () => {
    expect(buildMediaMetadata({ title: 'T', artist: 'A' }, coverUrl).album).toBe('');
    expect(buildMediaMetadata({ title: 'T', artist: 'A', album: null }, coverUrl).album).toBe('');
  });

  it('builds one artwork entry per size via the URL builder', () => {
    const m = buildMediaMetadata({ title: 'T', artist: 'A', coverArt: 'cov1' }, coverUrl);
    expect(m.artwork).toHaveLength(ARTWORK_SIZES.length);
    expect(m.artwork[0]).toEqual({
      src: 'https://srv/api/cover/cov1?size=96',
      sizes: '96x96',
      type: 'image/jpeg',
    });
    expect(m.artwork.map((a) => a.sizes)).toEqual(['96x96', '256x256', '512x512']);
  });

  it('emits no artwork when the track has no cover', () => {
    expect(buildMediaMetadata({ title: 'T', artist: 'A' }, coverUrl).artwork).toEqual([]);
    expect(
      buildMediaMetadata({ title: 'T', artist: 'A', coverArt: null }, coverUrl).artwork,
    ).toEqual([]);
  });
});
