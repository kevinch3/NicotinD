import type { ToastConfig } from '../../services/toast.service';
import type { AutoFetchImageResult } from '../../services/api/api-types';

/**
 * Signals "the action ran and correctly changed nothing", so the shared
 * busy-guard skips its `changed` emit without mistaking a no-op for a failure.
 */
export class NoChangeError extends Error {
  constructor() {
    super('no change');
    this.name = 'NoChangeError';
  }
}

/**
 * What to tell the user after "Fetch automatically". Pure so it can be tested
 * without an injection context, and exhaustive so a new server-side reason
 * cannot silently fall back to saying nothing — which is the bug this replaces
 * (#988): every outcome, including success, produced no message at all.
 */
export function autoFetchToast(result: AutoFetchImageResult): ToastConfig {
  if (result.filled) {
    return {
      message: result.source ? `New portrait from ${result.source}` : 'New portrait fetched',
      kind: 'success',
    };
  }
  switch (result.reason) {
    case 'manual-override':
      return {
        message: 'This artist has a portrait you set — reset it first to auto-fetch',
        kind: 'info',
      };
    case 'no-candidate':
      return { message: 'No provider had a photo for this artist', kind: 'info' };
    case 'no-cache-dir':
      return { message: 'Artwork cache is not configured on the server', kind: 'error' };
    case 'not-found':
      return { message: 'That artist no longer exists', kind: 'error' };
    case 'error':
      return { message: "Couldn't reach the image providers — try again", kind: 'error' };
  }
}
