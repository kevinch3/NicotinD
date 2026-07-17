/**
 * Candidate server URLs for a pairing QR payload. The phone probes these in
 * order and keeps the first one whose /api/health answers.
 *
 * - Funnel public URL first: works from anywhere, real HTTPS.
 * - Request origin second: on a reverse-proxied / Docker deployment the Host
 *   header is exactly the address the admin's browser reached the server on,
 *   so it's a valid candidate even without Tailscale. Loopback origins are
 *   dropped — the desktop renderer hits 127.0.0.1, which no phone can use.
 */
export function candidateUrls(opts: {
  funnelUrl?: string | null;
  requestOrigin: string;
}): string[] {
  const urls: string[] = [];
  if (opts.funnelUrl) urls.push(opts.funnelUrl);
  if (!isLoopbackOrigin(opts.requestOrigin)) urls.push(opts.requestOrigin);
  return [...new Set(urls)];
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      /^127(\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return true; // unparseable origin is never a usable candidate
  }
}
