// Detects a pasted/shared URL in the search omnibox and classifies it by host
// for a neutral chip label ("YouTube", "SoundCloud", …). Purely cosmetic — the
// server's registry.getEnabledForUrl() still picks the real backend at submit
// time. See docs/source-agnostic-acquisition.md.

export type LinkSource = 'youtube' | 'soundcloud' | 'bandcamp' | 'spotify' | 'archive' | 'link';

export interface LinkIntent {
  url: string;
  source: LinkSource;
  sourceLabel: string;
  host: string;
}

interface HostRule {
  test: (host: string) => boolean;
  source: LinkSource;
  label: string;
}

const HOST_RULES: HostRule[] = [
  {
    test: (h) =>
      h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com' || h === 'youtu.be',
    source: 'youtube',
    label: 'YouTube',
  },
  {
    test: (h) => h === 'soundcloud.com' || h === 'www.soundcloud.com',
    source: 'soundcloud',
    label: 'SoundCloud',
  },
  {
    test: (h) => h === 'bandcamp.com' || h.endsWith('.bandcamp.com'),
    source: 'bandcamp',
    label: 'Bandcamp',
  },
  {
    test: (h) => h === 'spotify.com' || h === 'www.spotify.com' || h === 'open.spotify.com',
    source: 'spotify',
    label: 'Spotify',
  },
  {
    test: (h) => h === 'archive.org' || h === 'www.archive.org',
    source: 'archive',
    label: 'Internet Archive',
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

  const host = new URL(candidate).hostname.toLowerCase();
  const rule = HOST_RULES.find((r) => r.test(host));
  return {
    url: trimmed,
    source: rule?.source ?? 'link',
    sourceLabel: rule?.label ?? 'Link',
    host,
  };
}
