import type { TransferEntry } from './transferTypes';

/** Returns true if any entry in `next` just reached Completed, Succeeded for the first time. */
export function detectNewCompletion(
  prev: Map<string, TransferEntry>,
  next: Map<string, TransferEntry>,
): boolean {
  for (const [key, entry] of next) {
    if (
      entry.state === 'Completed, Succeeded' &&
      prev.get(key)?.state !== 'Completed, Succeeded'
    ) {
      return true;
    }
  }
  return false;
}
