// Server-URL helpers for the self-hosted/native app. On the web build the app is
// served same-origin and `baseUrl` is '' (relative paths, unchanged behavior). In
// the Capacitor Android shell there is no same-origin server, so the user picks a
// server (default below) and every `/api`/`/rest` request is rewritten to absolute.
// Kept pure + DI-free so the logic is unit-testable without Angular (the web JIT
// test runner can't drive component input() signals — see project memory).

export const DEFAULT_SERVER_URL = 'https://nicotined.kevinroberts.ar';

/**
 * Normalize user-entered server input into a canonical origin: trims, defaults to
 * https:// when no scheme is given, drops any path/query and trailing slash.
 * Returns '' for empty/whitespace input (web same-origin sentinel).
 */
export function normalizeServerUrl(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** True when `path` is already an absolute http(s) URL (leave it untouched). */
function isAbsolute(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/**
 * Build the request URL for an API/REST path. With an empty `baseUrl` (web,
 * same-origin) the relative path is returned unchanged; with a configured base it
 * is prefixed. Absolute URLs and non-API paths pass through untouched.
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  if (isAbsolute(path)) return path;
  if (!baseUrl) return path;
  if (!path.startsWith('/api') && !path.startsWith('/rest')) return path;
  return `${baseUrl}${path}`;
}

/**
 * Build a WebSocket URL for an API ws path. With a configured `baseUrl` its
 * http(s) scheme maps to ws(s); otherwise fall back to the page origin (web).
 */
export function buildWsUrl(
  baseUrl: string,
  path: string,
  fallback: { protocol: string; host: string },
): string {
  if (baseUrl) {
    const u = new URL(baseUrl);
    const wsProto = u.protocol === 'https:' ? 'wss' : 'ws';
    return `${wsProto}://${u.host}${path}`;
  }
  const wsProto = fallback.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProto}://${fallback.host}${path}`;
}

/** Validate a `GET /api/health` body — the server returns `{ ok: true, version }`;
 * only `ok` is contractual (version is informational and may be 'unknown'). */
export function isHealthyResponse(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
}
