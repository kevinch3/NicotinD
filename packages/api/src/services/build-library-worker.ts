/**
 * Worker body for a full scan's `buildLibrary` (see LibraryScanner.scanFull).
 * The aggregation is pure but whole-library: ~1.2 s of CPU on a 21k-song
 * library locally, ~3 s on prod, all of it one event-loop stall at every boot.
 * Same function, different thread; the inputs are Maps/Sets of plain values,
 * so they survive the structured clone unchanged.
 */
import { buildLibrary } from './library-scanner.js';

declare const self: Worker;

export type BuildLibraryArgs = Parameters<typeof buildLibrary>;

self.onmessage = (event: MessageEvent<BuildLibraryArgs>) => {
  try {
    postMessage({ ok: true, built: buildLibrary(...event.data) });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
