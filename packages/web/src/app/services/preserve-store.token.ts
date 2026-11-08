import { InjectionToken } from '@angular/core';
import * as db from '../lib/preserve-store';

/**
 * The IndexedDB-backed store, injected so tests can swap in an in-memory fake.
 * The Angular unit-test system forbids `vi.mock` on relative imports, so the
 * store is provided through DI rather than module mocking.
 */
export interface PreserveStore {
  preserve: typeof db.preserve;
  remove: typeof db.remove;
  getBlob: typeof db.getBlob;
  getAll: typeof db.getAll;
  getAllCovers: typeof db.getAllCovers;
  getLyrics: typeof db.getLyrics;
  refreshLyrics: typeof db.refreshLyrics;
  evictLRU: typeof db.evictLRU;
  evictAutoLRU: typeof db.evictAutoLRU;
  removeAllAutoPreserved: typeof db.removeAllAutoPreserved;
  clearAll: typeof db.clearAll;
}

export const PRESERVE_STORE = new InjectionToken<PreserveStore>('PRESERVE_STORE', {
  providedIn: 'root',
  factory: () => db,
});
