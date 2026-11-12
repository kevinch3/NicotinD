import type {
  ArtistProvisioningStatus,
  DiscographyResult,
  ProvisioningAccepted,
} from '../services/api/api-types';

export const PROVISIONING_POLL_MS = 2_000;
export const DISCOGRAPHY_ART_POLL_MS = 3_000;
export const DISCOGRAPHY_ART_ATTEMPTS = 10;

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

/**
 * After an add, Lidarr's background refresh lists the albums before their
 * images (#1854). Re-read the discography in place while any album still has
 * no cover, applying each read, for a bounded number of attempts.
 */
export async function awaitDiscographyArt(
  initial: DiscographyResult,
  read: () => Promise<DiscographyResult>,
  apply: (d: DiscographyResult) => void,
  opts: {
    alive?: () => boolean;
    intervalMs?: number;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const alive = opts.alive ?? (() => true);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lacksArt = (d: DiscographyResult) => d.albums.some((a) => !a.coverArtUrl);
  let current = initial;
  for (let i = 0; i < (opts.attempts ?? DISCOGRAPHY_ART_ATTEMPTS) && lacksArt(current); i++) {
    await sleep(opts.intervalMs ?? DISCOGRAPHY_ART_POLL_MS);
    if (!alive()) return;
    current = await read();
    if (!alive()) return;
    apply(current);
  }
}
