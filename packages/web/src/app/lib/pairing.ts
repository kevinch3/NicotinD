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

/** Build the JSON string a pairing QR encodes. */
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

/** Parse + validate a scanned QR string; null for anything that isn't a
 * NicotinD pairing payload (so a stray QR scan fails soft). */
export function parsePairingPayload(raw: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PairingPayload>;
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
