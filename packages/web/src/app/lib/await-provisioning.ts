import type { ArtistProvisioningStatus, ProvisioningAccepted } from '../services/api/api-types';

export const PROVISIONING_POLL_MS = 2_000;

export function isProvisioningAccepted(v: unknown): v is ProvisioningAccepted {
  return typeof v === 'object' && v !== null && (v as ProvisioningAccepted).provisioning === true;
}

/**
 * Poll the add-artist job (issue #644) until it is no longer running for
 * `isOurs`'s artist. Resolves with the last status — the caller re-sends its
 * request and reads `lastOutcome`/`lastError` only when the status is still
 * its own — or null once `alive()` says the view that asked has gone.
 */
export async function awaitProvisioning(
  poll: () => Promise<ArtistProvisioningStatus>,
  isOurs: (s: ArtistProvisioningStatus) => boolean,
  opts: { alive?: () => boolean; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ArtistProvisioningStatus | null> {
  const alive = opts.alive ?? (() => true);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    await sleep(opts.intervalMs ?? PROVISIONING_POLL_MS);
    if (!alive()) return null;
    const status = await poll();
    if (!alive()) return null;
    if (status.phase === 'idle' || !isOurs(status)) return status;
  }
}
