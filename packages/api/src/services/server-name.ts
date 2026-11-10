/**
 * The name a person sees for this server — in email subjects and bodies and on
 * the invite page (docs/email-invitations.md).
 *
 * It used to be `os.hostname()`, which in Docker is the container id
 * (`95fe07a0e91c`): meaningless to a friend reading an invite, and the kind of
 * random string spam filters score against. The order is the operator's
 * explicit name, then the host of the public URL people already know the server
 * by, then a hostname only if it looks chosen by a human, else "NicotinD".
 */

/** A Docker/Podman container id: 12 or 64 lowercase hex characters. */
const CONTAINER_ID = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;

export function resolveServerName(opts: {
  /** `NICOTIND_SERVER_NAME`. */
  explicit?: string | null;
  publicUrl?: string | null;
  host?: string | null;
}): string {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit.slice(0, 100);
  if (opts.publicUrl) {
    try {
      const { hostname } = new URL(opts.publicUrl);
      if (hostname) return hostname;
    } catch {
      /* an unparseable URL is no name; fall through */
    }
  }
  const host = opts.host?.trim();
  if (host && !CONTAINER_ID.test(host) && host !== 'localhost') return host;
  return 'NicotinD';
}
