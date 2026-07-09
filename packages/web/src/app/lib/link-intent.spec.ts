import { describe, it, expect } from 'vitest';
import { parseLinkIntent } from './link-intent';

describe('parseLinkIntent', () => {
  it('returns null for plain search text', () => {
    expect(parseLinkIntent('pink floyd dark side of the moon')).toBeNull();
  });

  it('returns null for a single non-url word', () => {
    expect(parseLinkIntent('beatles')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseLinkIntent('   ')).toBeNull();
  });

  it('returns null for a bare scheme with no host', () => {
    expect(parseLinkIntent('http://')).toBeNull();
  });

  it('detects a youtube.com URL', () => {
    expect(parseLinkIntent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'www.youtube.com',
    });
  });

  it('detects a youtu.be short link', () => {
    const result = parseLinkIntent('https://youtu.be/dQw4w9WgXcQ');
    expect(result?.source).toBe('youtube');
    expect(result?.sourceLabel).toBe('YouTube');
  });

  it('detects a soundcloud.com URL', () => {
    const result = parseLinkIntent('https://soundcloud.com/artist/track');
    expect(result?.source).toBe('soundcloud');
    expect(result?.sourceLabel).toBe('SoundCloud');
  });

  it('detects a bandcamp subdomain URL', () => {
    const result = parseLinkIntent('https://artistname.bandcamp.com/album/name');
    expect(result?.source).toBe('bandcamp');
    expect(result?.sourceLabel).toBe('Bandcamp');
  });

  it('detects an open.spotify.com URL', () => {
    const result = parseLinkIntent('https://open.spotify.com/album/abc123');
    expect(result?.source).toBe('spotify');
    expect(result?.sourceLabel).toBe('Spotify');
  });

  it('detects an archive.org URL', () => {
    const result = parseLinkIntent('https://archive.org/details/some-item');
    expect(result?.source).toBe('archive');
    expect(result?.sourceLabel).toBe('Internet Archive');
  });

  it('falls back to a generic "Link" label for an unrecognized host', () => {
    const result = parseLinkIntent('https://example.com/track.mp3');
    expect(result?.source).toBe('link');
    expect(result?.sourceLabel).toBe('Link');
  });

  it('tolerates a bare www. host with no protocol', () => {
    const result = parseLinkIntent('www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result?.source).toBe('youtube');
    expect(result?.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
