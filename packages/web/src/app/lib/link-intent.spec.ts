import { describe, it, expect } from 'vitest';
import { parseLinkIntent, resolverClaims } from './link-intent';

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
      kind: 'video',
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

  it('returns null for whitespace-padded share text with a URL inside', () => {
    // Today whitespace means "not a link", so a search for words never misfires.
    expect(parseLinkIntent('Listen https://youtu.be/dQw4w9WgXcQ')).toBeNull();
  });

  it('trims a whitespace-padded URL', () => {
    expect(parseLinkIntent('  https://youtu.be/dQw4w9WgXcQ \n')?.source).toBe('youtube');
  });

  // #1663: the live chip says what a link is, not just whose it is.
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'video'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
    ['https://www.youtube.com/shorts/abc', 'youtube', 'video'],
    ['https://www.youtube.com/playlist?list=PL123', 'youtube', 'playlist'],
    ['https://www.youtube.com/watch?v=x&list=PL123', 'youtube', 'playlist'],
    ['https://music.youtube.com/playlist?list=OLAK5uy', 'youtube', 'playlist'],
    ['https://www.youtube.com/@artist', 'youtube', null],
    ['https://soundcloud.com/artist/track-name', 'soundcloud', 'track'],
    ['https://m.soundcloud.com/artist/sets/an-ep', 'soundcloud', 'playlist'],
    ['https://soundcloud.com/artist', 'soundcloud', 'artist'],
    ['https://on.soundcloud.com/AbC123', 'soundcloud', null],
    ['https://open.spotify.com/track/abc', 'spotify', 'track'],
    ['https://open.spotify.com/intl-es/album/abc', 'spotify', 'album'],
    ['https://open.spotify.com/playlist/abc?si=xyz', 'spotify', 'playlist'],
    ['https://open.spotify.com/artist/abc', 'spotify', 'artist'],
    ['https://open.spotify.com/episode/abc', 'spotify', null],
    ['https://name.bandcamp.com/album/record', 'bandcamp', 'album'],
    ['https://name.bandcamp.com/track/song', 'bandcamp', 'track'],
    ['https://name.bandcamp.com/', 'bandcamp', 'artist'],
    ['https://bandcamp.com/', 'bandcamp', null],
    ['https://archive.org/details/item', 'archive', null],
    ['https://example.com/a.mp3', 'link', null],
  ])('classifies %s as %s / %s', (url, source, kind) => {
    const intent = parseLinkIntent(url);
    expect(intent?.source).toBe(source);
    expect(intent?.kind).toBe(kind);
  });

  it.each(['spotify:track:abc', 'youtube.com/watch?v=x', 'ftp://archive.org/x', 'just words'])(
    'never matches the non-URL %s',
    (text) => {
      expect(parseLinkIntent(text)).toBeNull();
    },
  );
});

describe('resolverClaims', () => {
  const ARCHIVE = '^https?://([a-z0-9-]+\\.)?archive\\.org/';

  it('is true when an enabled resolver pattern matches', () => {
    expect(resolverClaims('https://archive.org/details/x', [ARCHIVE])).toBe(true);
  });

  it('is false when no pattern matches', () => {
    expect(resolverClaims('https://youtu.be/x', [ARCHIVE])).toBe(false);
    expect(resolverClaims('https://youtu.be/x', [])).toBe(false);
  });

  it('matches against the normalised href, as the server does', () => {
    // new URL() lowercases the host, so a pattern written for the canonical
    // form claims a link typed in capitals.
    expect(resolverClaims('https://ARCHIVE.org/details/x', [ARCHIVE])).toBe(true);
  });

  it('a catch-all resolver claims every http link', () => {
    expect(resolverClaims('https://example.com/a', ['^https?://'])).toBe(true);
  });

  it('is unknown (null) when the server did not list every resolver', () => {
    expect(resolverClaims('https://youtu.be/x', null)).toBeNull();
  });

  it('skips an invalid pattern instead of throwing', () => {
    expect(resolverClaims('https://archive.org/x', ['(', ARCHIVE])).toBe(true);
  });
});
