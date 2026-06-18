import { describe, it, expect } from 'vitest';
import { pickArtworkUrl, toNativeMetadata } from './now-playing';
import type { MediaMetadataInit } from './media-metadata';

describe('pickArtworkUrl', () => {
  it('picks the largest declared size', () => {
    const url = pickArtworkUrl([
      { src: 'a96', sizes: '96x96', type: 'image/jpeg' },
      { src: 'a512', sizes: '512x512', type: 'image/jpeg' },
      { src: 'a256', sizes: '256x256', type: 'image/jpeg' },
    ]);
    expect(url).toBe('a512');
  });

  it('returns undefined when there is no artwork', () => {
    expect(pickArtworkUrl([])).toBeUndefined();
  });

  it('tolerates a malformed sizes string', () => {
    const url = pickArtworkUrl([
      { src: 'bad', sizes: 'any', type: 'image/jpeg' },
      { src: 'good', sizes: '300x300', type: 'image/jpeg' },
    ]);
    expect(url).toBe('good');
  });
});

describe('toNativeMetadata', () => {
  it('maps title/artist/album and the best artwork url', () => {
    const meta: MediaMetadataInit = {
      title: 'T',
      artist: 'A',
      album: 'Alb',
      artwork: [
        { src: 'small', sizes: '96x96', type: 'image/jpeg' },
        { src: 'big', sizes: '512x512', type: 'image/jpeg' },
      ],
    };
    expect(toNativeMetadata(meta)).toEqual({
      title: 'T',
      artist: 'A',
      album: 'Alb',
      artworkUrl: 'big',
    });
  });

  it('omits artworkUrl when there is no cover', () => {
    const meta: MediaMetadataInit = { title: 'T', artist: 'A', album: '', artwork: [] };
    expect(toNativeMetadata(meta).artworkUrl).toBeUndefined();
  });
});
