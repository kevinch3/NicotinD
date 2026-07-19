// Device-pairing helpers shared by the desktop "Link a device" page (QR payload
// building) and the phone's server-picker (scan → probe → claim). Kept pure +
// DI-free so the logic is unit-testable without Angular.

import { buildApiUrl, isHealthyResponse } from './server-url';

export interface PairingPayload {
  v: 1;
  kind: 'nicotind-pair';
  /** Server display name (hostname) — cosmetic only. */
  name?: string;
  /** Candidate server URLs, probed in order. */
  urls: string[];
  token: string;
}

/** Build the JSON string a pairing QR encodes (legacy format — QRs minted by
 * pre-link builds; still parsed for cross-version pairing). */
export function buildPairingPayload(opts: { name: string; urls: string[]; token: string }): string {
  const payload: PairingPayload = {
    v: 1,
    kind: 'nicotind-pair',
    name: opts.name,
    urls: opts.urls,
    token: opts.token,
  };
  return JSON.stringify(payload);
}

/**
 * Build the pairing *link* the QR now encodes: `<primary>/pair#t=…&u=…&n=…`.
 * A URL (instead of raw JSON) means the phone's built-in camera app can act on
 * the scan too — it opens the server's own `/pair` page in a browser, which
 * claims the token and signs in. The token rides in the fragment so it never
 * reaches server/proxy logs; extra candidate URLs are repeated `u` params.
 */
export function buildPairingLink(opts: { name?: string; urls: string[]; token: string }): string {
  const [primary, ...extras] = opts.urls;
  const params = new URLSearchParams();
  params.set('t', opts.token);
  for (const u of extras) params.append('u', u);
  if (opts.name) params.set('n', opts.name);
  return `${primary}/pair#${params.toString()}`;
}

/** Parse a `/pair` link's fragment (or query, as a fallback) into the payload
 * fields. Shared by the QR-scan path and the `/pair` web page itself. */
export function parsePairingParams(
  raw: string,
  origin?: string,
): { token: string; urls: string[]; name?: string } | null {
  const params = new URLSearchParams(raw.replace(/^[#?]/, ''));
  const token = params.get('t');
  if (!token) return null;
  const urls = [origin, ...params.getAll('u')].filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u),
  );
  return { token, urls, name: params.get('n') ?? undefined };
}

/** Parse + validate a scanned QR string — the pairing-link URL form or the
 * legacy JSON form; null for anything that isn't a NicotinD pairing payload
 * (so a stray QR scan fails soft). */
export function parsePairingPayload(raw: string): PairingPayload | null {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.pathname.endsWith('/pair')) return null;
      const parsed = parsePairingParams(url.hash || url.search, url.origin);
      if (!parsed) return null;
      return { v: 1, kind: 'nicotind-pair', name: parsed.name, urls: parsed.urls, token: parsed.token };
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<PairingPayload>;
    if (parsed.kind !== 'nicotind-pair' || parsed.v !== 1) return null;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    const urls = Array.isArray(parsed.urls)
      ? parsed.urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
      : [];
    return { v: 1, kind: 'nicotind-pair', name: parsed.name, urls, token: parsed.token };
  } catch {
    return null;
  }
}

/** Probe candidate URLs in order; resolve the first whose /api/health answers,
 * or null when none do. */
export async function probeCandidates(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  for (const url of urls) {
    try {
      const res = await fetchImpl(buildApiUrl(url, '/api/health'), {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => null);
      if (res.ok && isHealthyResponse(body)) return url;
    } catch {
      // unreachable candidate — try the next one
    }
  }
  return null;
}

/** Coarse browser label used as a `/pair`-page claim's default device name. */
export function describeBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return 'Edge browser';
  if (/firefox\//i.test(ua)) return 'Firefox browser';
  if (/chrome\//i.test(ua)) return 'Chrome browser';
  if (/safari\//i.test(ua)) return 'Safari browser';
  return 'Browser';
}

export interface ClaimResult {
  token: string;
  user: { id: string; username: string; role: string };
}

/** Exchange a pairing token/code for a session JWT. Runs pre-auth with raw
 * fetch (the HttpClient interceptor chain assumes an already-selected server). */
export async function claimPairing(
  serverUrl: string,
  body: { token?: string; code?: string; deviceName?: string; platform?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimResult> {
  const res = await fetchImpl(buildApiUrl(serverUrl, '/api/devices/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | (ClaimResult & { error?: string })
    | null;
  if (!res.ok || !parsed?.token) {
    throw new Error(parsed?.error ?? 'Pairing failed');
  }
  return parsed;
}
