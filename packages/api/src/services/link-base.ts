/**
 * Where links this server hands out should point — invites, reset links and the
 * test email all agree: the operator's public URL, then the Funnel URL, then
 * the address the admin's browser used (loopback dropped). See `candidateUrls`.
 */
import { candidateUrls } from './pairing-urls.js';
import type { RemoteAccess } from './tailscale.js';

export interface LinkBaseSources {
  /** The operator-declared public URL (env or mail settings); null when unset. */
  publicUrl?: (() => string | null) | null;
  /** Funnel URL source; null outside a Tailscale setup. */
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
}

export async function linkBaseCandidates(
  sources: LinkBaseSources,
  requestUrl: string,
): Promise<string[]> {
  const funnelUrl = sources.remoteAccess
    ? await sources.remoteAccess.publicUrl().catch(() => null)
    : null;
  return candidateUrls({
    publicUrl: sources.publicUrl?.() ?? null,
    funnelUrl,
    requestOrigin: new URL(requestUrl).origin,
  });
}
