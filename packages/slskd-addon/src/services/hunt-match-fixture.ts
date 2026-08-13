/**
 * Golden-dataset shape for the album-hunt recognizer replay tests. This mirrors
 * the on-disk JSON in `__fixtures__/hunt-match/` (exported from core's generation-
 * feedback review queue via `feedback-to-fixtures.ts`).
 *
 * Defined locally rather than imported from the host: it is a serialization
 * contract for the addon's own fixtures, and the addon must stand alone once
 * split into its own repo (phase 4). Core keeps its own equivalent definitions
 * for the capture/review side — the two describe the same JSON on disk.
 */
export type GenerationVerdict = 'good' | 'bad';

export interface CapturedSearchResponse {
  username: string;
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
  files: Array<{ filename: string; size: number; bitRate?: number }>;
}

export interface FolderRef {
  username: string;
  directory: string;
}

export interface HuntMatchFixture {
  canonicalTracks: Array<{ title: string }>;
  rawResponses: CapturedSearchResponse[];
  expected: { correctFolder: FolderRef | null };
  meta: {
    id: number;
    verdict: GenerationVerdict;
    artistName: string;
    albumTitle: string;
  };
}
