import { describe, it, expect } from 'bun:test';
import { classifyAcquireUrl, urlPathSegments } from './classify-acquire-url';

describe('urlPathSegments', () => {
  it('splits a path into non-empty segments', () => {
    expect(urlPathSegments('https://open.spotify.com/playlist/abc')).toEqual([
      'playlist',
      'abc',
    ]);
  });
  it('returns [] for an invalid URL', () => {
    expect(urlPathSegments('not a url')).toEqual([]);
  });
});

describe('classifyAcquireUrl', () => {
  describe('Spotify', () => {
    it('classifies /playlist/<id> as playlist', () => {
      expect(classifyAcquireUrl('https://open.spotify.com/playlist/abc123')).toEqual({
        source: 'spotify',
        kind: 'playlist',
      });
    });
    it('classifies /album/<id> as album', () => {
      expect(classifyAcquireUrl('https://open.spotify.com/album/abc123')).toEqual({
        source: 'spotify',
        kind: 'album',
      });
    });
    it('classifies /track/<id> as track', () => {
      expect(classifyAcquireUrl('https://open.spotify.com/track/abc123')).toEqual({
        source: 'spotify',
        kind: 'track',
      });
    });
    it('classifies an unknown Spotify path as unknown', () => {
      expect(classifyAcquireUrl('https://open.spotify.com/artist/abc123')).toEqual({
        source: 'spotify',
        kind: 'unknown',
      });
    });
    it('normalises www.spotify.com and spotify.com hosts', () => {
      expect(classifyAcquireUrl('https://www.spotify.com/playlist/x')).toEqual({
        source: 'spotify',
        kind: 'playlist',
      });
      expect(classifyAcquireUrl('https://spotify.com/playlist/x')).toEqual({
        source: 'spotify',
        kind: 'playlist',
      });
    });
  });

  describe('YouTube', () => {
    it('classifies /playlist as playlist', () => {
      expect(classifyAcquireUrl('https://www.youtube.com/playlist?list=PLabc')).toEqual({
        source: 'youtube',
        kind: 'playlist',
      });
    });
    it('classifies /watch with a list= query param as playlist', () => {
      expect(classifyAcquireUrl('https://www.youtube.com/watch?v=abc&list=PLxyz')).toEqual({
        source: 'youtube',
        kind: 'playlist',
      });
    });
    it('classifies /watch without list= as track', () => {
      expect(classifyAcquireUrl('https://www.youtube.com/watch?v=abc')).toEqual({
        source: 'youtube',
        kind: 'track',
      });
    });
    it('classifies youtu.be short links as track (no playlist signal)', () => {
      expect(classifyAcquireUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
        source: 'youtube',
        kind: 'track',
      });
    });
    it('handles music.youtube.com', () => {
      expect(classifyAcquireUrl('https://music.youtube.com/playlist?list=PLx')).toEqual({
        source: 'youtube',
        kind: 'playlist',
      });
    });
  });

  describe('archive.org', () => {
    it('classifies /details/<id> as album (override via `as` lives elsewhere)', () => {
      expect(classifyAcquireUrl('https://archive.org/details/foo-123')).toEqual({
        source: 'archive',
        kind: 'album',
      });
    });
    it('handles www.archive.org', () => {
      expect(classifyAcquireUrl('https://www.archive.org/details/bar')).toEqual({
        source: 'archive',
        kind: 'album',
      });
    });
  });

  describe('unknown sources', () => {
    it('classifies an arbitrary URL as unknown', () => {
      expect(classifyAcquireUrl('https://example.com/foo/bar')).toEqual({
        source: 'other',
        kind: 'unknown',
      });
    });
    it('returns unknown for an invalid URL', () => {
      expect(classifyAcquireUrl('not a url at all')).toEqual({
        source: 'other',
        kind: 'unknown',
      });
    });
  });
});