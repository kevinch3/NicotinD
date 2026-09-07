import { describe, it, expect } from 'vitest';
import { albumLoadFailureFor } from './album-load-state';

// The album page used to `catch { /* ignore */ }` and render one flat
// "Album not found." for every failure — a server error or a lost connection
// was reported as the one thing it definitely wasn't.
describe('albumLoadFailureFor', () => {
  it('reports a genuinely absent album as missing', () => {
    expect(albumLoadFailureFor({ status: 404, error: { code: 'ALBUM_NOT_FOUND' } })).toBe(
      'missing',
    );
  });

  it('treats a codeless 404 as missing, preserving pre-code server behaviour', () => {
    expect(albumLoadFailureFor({ status: 404, error: { error: 'Album not found' } })).toBe(
      'missing',
    );
  });

  it('reports a server error as unavailable rather than claiming the album is missing', () => {
    expect(albumLoadFailureFor({ status: 500, error: { error: 'boom' } })).toBe('unavailable');
  });

  it('reports a lost connection as unavailable, not missing', () => {
    // The offline/interceptor path surfaces status 0.
    expect(albumLoadFailureFor({ status: 0 })).toBe('unavailable');
  });

  it('reports an auth failure as unavailable, not missing', () => {
    expect(albumLoadFailureFor({ status: 401 })).toBe('unavailable');
  });
});
