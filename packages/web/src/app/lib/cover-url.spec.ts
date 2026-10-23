import { describe, expect, it } from 'vitest';
import { withMediaToken } from './cover-url';

describe('withMediaToken', () => {
  const remote = `/api/cover/remote?u=${encodeURIComponent('https://images.lidarr.audio/c.jpg')}`;

  it('appends the token to a proxied catalog cover', () => {
    expect(withMediaToken(remote, 'mk')).toBe(`${remote}&token=mk`);
  });

  it('uses ? when the cover URL has no query yet', () => {
    expect(withMediaToken('/api/cover/abc', 'mk')).toBe('/api/cover/abc?token=mk');
  });

  it('leaves a URL that already carries a token alone', () => {
    expect(withMediaToken('/api/cover/abc?size=300&token=old', 'mk')).toBe(
      '/api/cover/abc?size=300&token=old',
    );
  });

  it('never sends the token to a third-party URL', () => {
    expect(withMediaToken('https://i.scdn.co/image/x', 'mk')).toBe('https://i.scdn.co/image/x');
  });

  it('passes through a missing URL or a signed-out session', () => {
    expect(withMediaToken(undefined, 'mk')).toBeUndefined();
    expect(withMediaToken(remote, null)).toBe(remote);
  });
});
