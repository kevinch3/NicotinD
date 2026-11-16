import type { CompleteAlbumResponse } from '../services/api/api-types';

/** How each outcome of a "complete this album" request reads as a toast. */
export const COMPLETE_OUTCOME_KIND: Record<
  CompleteAlbumResponse['outcome'],
  'info' | 'success' | 'error'
> = {
  enqueued: 'success',
  'already-complete': 'info',
  'in-flight': 'info',
  'no-candidate': 'info',
  'slskd-unavailable': 'error',
  'enqueue-failed': 'error',
};
