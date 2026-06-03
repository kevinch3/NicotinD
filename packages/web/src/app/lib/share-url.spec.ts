import { extractSharedUrl } from './share-url';

describe('extractSharedUrl', () => {
  it('returns a bare URL', () => {
    expect(extractSharedUrl('https://youtu.be/abc')).toBe('https://youtu.be/abc');
  });

  it('extracts a URL embedded in shared text', () => {
    expect(extractSharedUrl('Check this out https://open.spotify.com/track/xyz now')).toBe(
      'https://open.spotify.com/track/xyz',
    );
  });

  it('prefers the first non-empty input that contains a URL', () => {
    expect(extractSharedUrl(null, '', 'no url here', 'go https://x.com/y')).toBe('https://x.com/y');
  });

  it('returns null when no input has a URL', () => {
    expect(extractSharedUrl(null, undefined, 'just a title', '')).toBeNull();
  });

  it('trims surrounding whitespace on a bare URL', () => {
    expect(extractSharedUrl('  https://soundcloud.com/a/b  ')).toBe('https://soundcloud.com/a/b');
  });
});
