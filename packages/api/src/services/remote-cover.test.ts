import { describe, expect, it } from 'bun:test';
import {
  isProxyableCoverUrl,
  proxiedCoverUrl,
  remoteCoverCacheKey,
  resolveRemoteCoverUrl,
} from './remote-cover.js';

// The two shapes prod Lidarr actually returns for an album cover.
const CDN_ORIGINAL =
  'https://images.lidarr.audio/cache/https://coverartarchive.org/release/8a6e3c36-298c-4bc5-b75a-61849f1e291e/18380977239-1200.jpg';
const LIDARR_RELATIVE = '/MediaCover/Albums/1/cover.jpg?lastWrite=639157751579851494';

describe('proxiedCoverUrl (#263)', () => {
  it('routes a CDN original through our own origin', () => {
    const url = proxiedCoverUrl(CDN_ORIGINAL);
    expect(url).toBe(`/api/cover/remote?u=${encodeURIComponent(CDN_ORIGINAL)}`);
    // Relative so ServerConfigService.apiUrl() can point it at the right host.
    expect(url!.startsWith('/api/')).toBe(true);
  });

  it('routes the Lidarr-relative shape too (the browser cannot reach it)', () => {
    expect(proxiedCoverUrl(LIDARR_RELATIVE)).toBe(
      `/api/cover/remote?u=${encodeURIComponent(LIDARR_RELATIVE)}`,
    );
  });

  it('returns undefined for a missing cover so the card shows its placeholder', () => {
    expect(proxiedCoverUrl(undefined)).toBeUndefined();
    expect(proxiedCoverUrl(null)).toBeUndefined();
    expect(proxiedCoverUrl('')).toBeUndefined();
  });

  it('refuses a host outside the allowlist', () => {
    // An open proxy would be an SSRF hole.
    expect(proxiedCoverUrl('https://evil.example.com/x.jpg')).toBeUndefined();
    expect(proxiedCoverUrl('http://169.254.169.254/latest/meta-data/')).toBeUndefined();
    expect(proxiedCoverUrl('file:///etc/passwd')).toBeUndefined();
  });
});

describe('resolveRemoteCoverUrl', () => {
  it('passes an allowlisted absolute URL through', () => {
    expect(resolveRemoteCoverUrl(CDN_ORIGINAL, 'http://lidarr:8686')).toBe(CDN_ORIGINAL);
  });

  it('resolves a Lidarr-relative path against the configured Lidarr base URL', () => {
    expect(resolveRemoteCoverUrl(LIDARR_RELATIVE, 'http://lidarr:8686')).toBe(
      `http://lidarr:8686${LIDARR_RELATIVE}`,
    );
  });

  it('rejects a Lidarr-relative path when no Lidarr is configured', () => {
    expect(resolveRemoteCoverUrl(LIDARR_RELATIVE, null)).toBeNull();
  });

  it('rejects non-allowlisted and malformed values', () => {
    expect(
      resolveRemoteCoverUrl('https://evil.example.com/x.jpg', 'http://lidarr:8686'),
    ).toBeNull();
    expect(resolveRemoteCoverUrl('not a url', 'http://lidarr:8686')).toBeNull();
    expect(resolveRemoteCoverUrl(undefined, 'http://lidarr:8686')).toBeNull();
  });

  it('cannot be tricked into an internal host by an allowlisted-looking prefix', () => {
    expect(
      resolveRemoteCoverUrl('https://images.lidarr.audio.evil.com/x.jpg', 'http://lidarr:8686'),
    ).toBeNull();
  });
});

describe('remoteCoverCacheKey', () => {
  it('is content-addressed on the upstream URL', () => {
    expect(remoteCoverCacheKey(CDN_ORIGINAL)).toBe(remoteCoverCacheKey(CDN_ORIGINAL));
    expect(remoteCoverCacheKey(CDN_ORIGINAL)).not.toBe(remoteCoverCacheKey('https://x/y.jpg'));
  });

  it('is namespaced away from library cover ids', () => {
    expect(remoteCoverCacheKey(CDN_ORIGINAL).startsWith('r_')).toBe(true);
  });
});

describe('isProxyableCoverUrl', () => {
  it('accepts the allowlisted art hosts', () => {
    expect(isProxyableCoverUrl('https://coverartarchive.org/release/x/1.jpg')).toBe(true);
    expect(isProxyableCoverUrl(CDN_ORIGINAL)).toBe(true);
  });
});
