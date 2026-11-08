/**
 * A random v4 UUID that works on every origin (#1724).
 *
 * `crypto.randomUUID` exists only in a secure context (HTTPS or localhost), and
 * plain HTTP on a LAN or tailnet IP is how most self-hosters first open the
 * app. There it is undefined and calling it throws. `crypto.getRandomValues`
 * is available everywhere, so the fallback builds the same RFC 4122 v4 shape
 * from it. ESLint bans direct `crypto.randomUUID` in the web package; use this.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
