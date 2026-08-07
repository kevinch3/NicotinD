/**
 * The human-typable pairing / TV sign-in code alphabet, shared so the server
 * that mints a code and the client that validates a scan can't drift apart
 * (issue #434 put a validator on the web side; the minter lives in the API's
 * `routes/devices.ts`).
 *
 * 6 chars over 32 symbols with the ambiguous 0/O/1/I removed — ~1.07e9
 * combinations against a 5-minute TTL and the claim rate limiter.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Whether `value` is shaped like a minted code. Case-insensitive — the TV
 *  renders uppercase but a hand-typed code shouldn't have to be. */
export function isPairingCodeShape(value: string): boolean {
  return CODE_RE.test(value.trim().toUpperCase());
}
