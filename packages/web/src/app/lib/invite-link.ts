/**
 * Invite link helpers (docs/email-invitations.md), pure so both the admin card
 * and the landing page share one parser and one builder.
 */

/** `#t=<token>` (the link's form) or `?t=<token>` (a hand-edited fallback). */
export function parseInviteToken(hash: string, search = ''): string | null {
  for (const raw of [hash, search]) {
    const params = new URLSearchParams(raw.replace(/^[#?]/, ''));
    const token = params.get('t')?.trim();
    if (token) return token;
  }
  return null;
}

/**
 * The shareable link. Uses the server's first usable base (Funnel, then the
 * address the admin reached it on); with none, falls back to this page's
 * origin and reports `localOnly` so the card can warn that a friend elsewhere
 * cannot open it — the desktop app's 127.0.0.1 is the case that matters.
 */
export function buildInviteLink(
  urls: string[],
  path: string,
  fallbackOrigin: string,
): { link: string; localOnly: boolean } {
  const base = urls[0] ?? fallbackOrigin;
  return { link: base.replace(/\/+$/, '') + path, localOnly: urls.length === 0 };
}
