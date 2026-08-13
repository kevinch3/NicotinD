import { isIP } from 'node:net';

/**
 * SSRF guard for URLs core fetches on an addon's behalf (see
 * docs/superpowers/specs/2026-08-13-addon-ecosystem-security-contract-foundation-design.md,
 * Stream 2). An addon's own base URL is admin-chosen and out of scope; this
 * guards `url`-typed fields *inside* an addon response (e.g. a search result's
 * cover URL core would proxy), which are attacker-chosen.
 *
 * Threat model is admin-installs / semi-trusted, so this is a synchronous
 * literal-target guard: scheme + literal-IP-range + localhost + optional host
 * allowlist. DNS-level SSRF (a hostname that RESOLVES to an internal IP) is a
 * documented follow-up — it needs a resolve-then-pin at the socket to be
 * rebinding-safe, which belongs at the fetch call site, not this pure guard.
 */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`refusing to fetch URL: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

/** Pure: is `host` a literal IP in a loopback / private / link-local range? */
export function isPrivateIpHost(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) return isPrivateIpv6(host);
  return false; // not an IP literal — a hostname, handled elsewhere
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — refuse rather than guess
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — apply the v4 rules to the embedded address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (lower.startsWith('fe80')) return true; // fe80::/10 link-local
  // fc00::/7 unique-local — first byte 0xfc or 0xfd.
  if (/^f[cd]/.test(lower)) return true;
  return false;
}

export interface FetchGuardOptions {
  /** When set, the URL host must be exactly one of these (in addition to the range checks). */
  allowedHosts?: ReadonlySet<string>;
}

/**
 * Pure: parse `raw` and throw `SsrfBlockedError` unless it is safe for core to
 * fetch. Returns the parsed `URL` on success.
 */
export function assertFetchableUrl(raw: string, opts: FetchGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('not a valid absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`scheme ${url.protocol} not allowed`);
  }

  // url.hostname keeps IPv6 literals bracketed ("[::1]"); strip for the IP check.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // localhost by name (a hostname, so the IP check below wouldn't catch it).
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfBlockedError('localhost is not fetchable');
  }

  // Bracketed IPv6 arrives from url.hostname without brackets already.
  if (isPrivateIpHost(host)) {
    throw new SsrfBlockedError(`private/loopback address ${host}`);
  }

  if (opts.allowedHosts && !opts.allowedHosts.has(host)) {
    throw new SsrfBlockedError(`host ${host} not in allowlist`);
  }

  return url;
}
