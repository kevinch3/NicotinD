/**
 * Sanitize a post-login `returnUrl` (issue #231) down to a safe in-app path.
 *
 * The auth guard stashes the URL an unauthenticated user tried to open as a
 * `returnUrl` query param on `/login`; after sign-in the login page navigates
 * there. That value is attacker-influenceable (it rides in a link's query
 * string), so it must be validated to a same-origin in-app path before we hand
 * it to the router — otherwise a crafted link could open-redirect a freshly
 * authenticated user off-site.
 *
 * Accepts only a single-slash-rooted relative path (`/library/artists/x`).
 * Rejects, falling back to `/`:
 *  - absolute/scheme URLs (`https://evil`, `javascript:…`, `nicotind://…`)
 *  - protocol-relative (`//evil.com`) and backslash tricks (`/\evil.com`)
 *  - a return to `/login` itself (would bounce straight back into the login page)
 */
export function sanitizeReturnUrl(raw: string | null | undefined): string {
  if (!raw) return '/';
  const value = raw.trim();
  // Must be a rooted relative path…
  if (!value.startsWith('/')) return '/';
  // …but not protocol-relative or a backslash-smuggled authority.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  // No control chars / whitespace-smuggling.
  if (/[\s]/.test(value)) return '/';
  // Don't loop back into the login route.
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return '/';
  return value;
}
