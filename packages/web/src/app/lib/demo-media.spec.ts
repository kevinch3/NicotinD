import { describe, expect, it } from 'vitest';
import { demoHash, demoMediaPath } from './demo-media';

describe('demoMediaPath', () => {
  it('maps a local cover to its shipped file, dropping size, rev and token', () => {
    expect(demoMediaPath('/api/cover/abc123?size=256&v=2&token=t')).toBe(
      'demo-media/covers/abc123.jpg',
    );
  });

  it('maps a server-built remote cover by the hash of its source URL', () => {
    const u = 'https://example.org/cover.jpg';
    expect(demoMediaPath(`/api/cover/remote?u=${encodeURIComponent(u)}`)).toBe(
      `demo-media/remote/${demoHash(u)}.jpg`,
    );
  });

  it('maps a stream to the shipped audio file', () => {
    expect(demoMediaPath('/api/stream/s1')).toMatch(/^demo-media\/audio\/s1\.(webm|m4a)$/);
  });

  it('leaves everything else alone', () => {
    expect(demoMediaPath('/api/library/albums')).toBeNull();
  });
});

describe('demoHash', () => {
  it('is stable and 8 hex chars', () => {
    expect(demoHash('x')).toBe(demoHash('x'));
    expect(demoHash('x')).toMatch(/^[0-9a-f]{8}$/);
    expect(demoHash('x')).not.toBe(demoHash('y'));
  });
});
