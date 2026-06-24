import type {
  AlbumCoverCandidate,
  CoverCandidatesResponse,
  ApplyCoverRequest,
} from '../../types/core';

/**
 * Pure helpers for the Fix-metadata cover picker. Kept DI-free so the logic is
 * unit-testable (the JIT vitest harness can't drive `input()` into a render).
 */

/** Flatten the grouped response into one ordered list: current → Lidarr → files. */
export function flattenCoverCandidates(res: CoverCandidatesResponse): AlbumCoverCandidate[] {
  const out: AlbumCoverCandidate[] = [];
  if (res.current) out.push(res.current);
  out.push(...res.lidarr, ...res.files);
  return out;
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A renderable thumbnail src for a candidate. External URLs (Lidarr) pass
 * through untouched; our own relative `/api/cover/...` URLs get the auth token +
 * a size bucket appended. The caller wraps the result with `ServerConfigService.apiUrl`
 * so it resolves in the native shell too.
 */
export function coverThumbUrl(c: AlbumCoverCandidate, token: string, size = 160): string {
  if (isAbsoluteUrl(c.url)) return c.url;
  const sep = c.url.includes('?') ? '&' : '?';
  return `${c.url}${sep}size=${size}&token=${encodeURIComponent(token)}`;
}

/**
 * Map a selected candidate to a cover-only apply payload. Returns null for the
 * `current` cover (selecting it is a no-op) or a `file` candidate missing its
 * songId.
 */
export function coverCandidateToRequest(c: AlbumCoverCandidate): ApplyCoverRequest | null {
  if (c.source === 'current') return null;
  if (c.source === 'file') return c.songId ? { songId: c.songId } : null;
  return { coverUrl: c.url };
}

/** Map a free-text cover URL to an apply payload, or null when blank. */
export function customCoverToRequest(url: string): ApplyCoverRequest | null {
  const trimmed = url.trim();
  return trimmed ? { coverUrl: trimmed } : null;
}
