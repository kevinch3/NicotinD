// Detects a pasted/shared URL in the search omnibox and classifies it by host
// for a neutral chip label ("YouTube", "SoundCloud", …) and, from the path, what
// it points at (a video, a playlist, …). Purely cosmetic: whether an enabled
// resolver claims the link is `resolverClaims` against the server's own
// `urlPatterns`, and the server still picks the real backend at submit time.
// See docs/source-agnostic-acquisition.md.

export type LinkSource = 'youtube' | 'soundcloud' | 'bandcamp' | 'spotify' | 'archive' | 'link';

/** What the link points at, when its path says so. Null when it does not. */
export type LinkKind = 'video' | 'track' | 'album' | 'playlist' | 'artist';

export interface LinkIntent {
  url: string;
  source: LinkSource;
  sourceLabel: string;
  host: string;
  kind: LinkKind | null;
}

interface HostRule {
  test: (host: string) => boolean;
  source: LinkSource;
  label: string;
  kind: (url: URL) => LinkKind | null;
}

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function youtubeKind(url: URL): LinkKind | null {
  // An `RD…` list on a watch URL is YouTube's auto-generated mix, not a playlist.
  const list = url.searchParams.get('list');
  const mixOnVideo = list?.startsWith('RD') && url.searchParams.has('v');
  if ((list !== null && !mixOnVideo) || url.pathname === '/playlist') return 'playlist';
  if (url.hostname === 'youtu.be') return segments(url).length > 0 ? 'video' : null;
  const [first] = segments(url);
  return first === 'watch' || first === 'shorts' ? 'video' : null;
}

/** SoundCloud's own top-level pages, which are not a user profile. */
const SOUNDCLOUD_RESERVED_TOP = new Set([
  'discover',
  'search',
  'you',
  'stream',
  'charts',
  'upload',
]);
/** A profile's list tabs: many items, not one track. */
const SOUNDCLOUD_PROFILE_TABS = new Set([
  'likes',
  'tracks',
  'albums',
  'reposts',
  'popular-tracks',
  'sets',
  'followers',
  'following',
]);

function soundcloudKind(url: URL): LinkKind | null {
  // on.soundcloud.com is a share shortener: the path is an opaque code.
  if (url.hostname === 'on.soundcloud.com') return null;
  const parts = segments(url);
  if (parts.length === 0 || SOUNDCLOUD_RESERVED_TOP.has(parts[0].toLowerCase())) return null;
  if (parts[1] === 'sets' && parts.length >= 3) return 'playlist';
  if (parts.length === 2 && SOUNDCLOUD_PROFILE_TABS.has(parts[1].toLowerCase())) return null;
  if (parts.length === 1) return 'artist';
  return parts.length === 2 ? 'track' : null;
}

function spotifyKind(url: URL): LinkKind | null {
  // Spotify's locale prefix: /intl-es/album/…, /intl-pt-br/track/…
  const [first] = segments(url).filter((s) => !/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(s));
  if (first === 'track' || first === 'album' || first === 'playlist' || first === 'artist') {
    return first;
  }
  return null;
}

function bandcampKind(url: URL): LinkKind | null {
  const [first] = segments(url);
  if (first === 'album' || first === 'track') return first;
  return first === undefined && url.hostname !== 'bandcamp.com' ? 'artist' : null;
}

const HOST_RULES: HostRule[] = [
  {
    test: (h) =>
      h === 'youtube.com' ||
      h === 'www.youtube.com' ||
      h === 'm.youtube.com' ||
      h === 'music.youtube.com' ||
      h === 'youtu.be',
    source: 'youtube',
    label: 'YouTube',
    kind: youtubeKind,
  },
  {
    test: (h) =>
      h === 'soundcloud.com' ||
      h === 'www.soundcloud.com' ||
      h === 'm.soundcloud.com' ||
      h === 'on.soundcloud.com',
    source: 'soundcloud',
    label: 'SoundCloud',
    kind: soundcloudKind,
  },
  {
    test: (h) => h === 'bandcamp.com' || h.endsWith('.bandcamp.com'),
    source: 'bandcamp',
    label: 'Bandcamp',
    kind: bandcampKind,
  },
  {
    test: (h) => h === 'spotify.com' || h === 'www.spotify.com' || h === 'open.spotify.com',
    source: 'spotify',
    label: 'Spotify',
    kind: spotifyKind,
  },
  {
    test: (h) => h === 'archive.org' || h === 'www.archive.org',
    source: 'archive',
    label: 'Internet Archive',
    kind: () => null,
  },
];

/**
 * Parses free-text search input as a link intent. Returns null for anything
 * that isn't clearly a URL (no whitespace tolerated) so ordinary search text
 * never misfires as a link.
 */
export function parseLinkIntent(input: string): LinkIntent | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const looksLikeWww = /^www\./i.test(trimmed);
  if (!hasProtocol && !looksLikeWww) return null;

  const candidate = hasProtocol ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return null;

  const parsed = new URL(candidate);
  const host = parsed.hostname.toLowerCase();
  const rule = HOST_RULES.find((r) => r.test(host));
  return {
    url: candidate,
    source: rule?.source ?? 'link',
    sourceLabel: rule?.label ?? 'Link',
    host,
    kind: rule?.kind(parsed) ?? null,
  };
}

/**
 * Whether any of the enabled resolvers' `urlPatterns` claims the URL — the same
 * test the server's `resolveAddonForUrl` runs, against the same normalised
 * `href`. `null` patterns means the server did not say (an enabled resolver
 * that is not an addon), which is never reported as unsupported.
 */
export function resolverClaims(url: string, patterns: readonly string[] | null): boolean | null {
  if (patterns === null) return null;
  if (!URL.canParse(url)) return false;
  const href = new URL(url).href;
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(href);
    } catch {
      return false;
    }
  });
}
