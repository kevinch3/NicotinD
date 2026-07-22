import type { SlskdSearchResponse } from './slskd.js';

/**
 * Generation-feedback: a dev golden-dataset primitive. Every "generated"/inferred
 * NicotinD output (album-hunt recognition, radio, generated playlists, library
 * listings, search) can be captured as an `(input, output, verdict)` snapshot and
 * later exported to a replayable test fixture. See docs/generation-feedback.md.
 *
 * v1 wires only `hunt-match`; the other members reserve the schema so radio/etc.
 * wire in later with no DB change.
 */
export type GenerationFeedbackResourceType =
  | 'hunt-match'
  | 'radio'
  | 'playlist'
  | 'library'
  | 'search';

/** The human's overall grade of a generated result. */
export type GenerationVerdict = 'good' | 'bad';

/** A slskd peer folder, uniquely identified by peer + directory. */
export interface FolderRef {
  username: string;
  directory: string;
}

/**
 * Per-item human truth attached on a 👎. `correctFolder` is the folder the human
 * says the recognizer SHOULD have ranked #1 (null = "none of these were right");
 * `wrongCandidates` are ones explicitly marked wrong.
 */
export interface HuntMatchItemFlags {
  correctFolder?: FolderRef | null;
  wrongCandidates?: FolderRef[];
}

/** The MusicBrainz/Lidarr proposal that seeded a hunt — the snapshot INPUT. */
export interface HuntMatchInput {
  artistName: string;
  albumTitle: string;
  lidarrAlbumId?: number;
  /** album.foreignAlbumId — the MusicBrainz release-group MBID. */
  releaseGroupMbid?: string;
  /** album.artist.foreignArtistId — the MusicBrainz artist MBID. */
  artistMbid?: string;
  canonicalTracks: Array<{ trackNumber?: number; title: string }>;
}

/**
 * Structural shape of a scored folder candidate as captured in a snapshot. Kept
 * structural (not imported from the API package) so `@nicotind/core` stays a leaf
 * dependency; the API's `FolderCandidate` is assignable to this.
 */
export interface SnapshotFolderCandidate {
  directory: string;
  username: string;
  matchPct: number;
  matchedTracks: number;
  totalTracks: number;
  format: string;
  files: Array<{ filename: string; size: number; bitRate?: number }>;
}

/**
 * The Soulseek recognition — the snapshot OUTPUT. `rawResponses` are the verbatim
 * slskd responses (including sub-floor folders the recognizer dropped), which is
 * what makes a captured fixture replayable through the pure `scoreFolders`.
 */
export interface HuntMatchOutput {
  rawResponses: SlskdSearchResponse[];
  candidates: SnapshotFolderCandidate[];
  chosen?: FolderRef | null;
}

export interface HuntMatchSnapshot {
  resourceType: 'hunt-match';
  input: HuntMatchInput;
  output: HuntMatchOutput;
}

/** Read model returned by `GET /api/feedback`. `input`/`output` are the parsed
 *  snapshot JSON (shape depends on `resourceType`). */
export interface GenerationFeedbackRecord {
  id: number;
  at: number;
  userId: string;
  username: string | null;
  resourceType: GenerationFeedbackResourceType;
  resourceRef: string | null;
  verdict: GenerationVerdict | null;
  note: string | null;
  input: unknown;
  output: unknown;
  itemFlags: HuntMatchItemFlags | null;
  engineVersion: string | null;
}

/** Body of `PATCH /api/feedback/:id` (grade a pending capture). */
export interface ResolveFeedbackBody {
  verdict: GenerationVerdict;
  note?: string;
  itemFlags?: HuntMatchItemFlags;
}

/**
 * A graded hunt-match capture, distilled into a replayable test fixture. The
 * replay harness re-runs the pure `scoreFolders(canonicalTracks, rawResponses)`
 * and asserts `ranked[0]` equals `expected.correctFolder`. `null` correctFolder
 * means the human said none of the candidates were right — the recognizer should
 * surface nothing at #1 that the human accepted (documented known-gap case).
 */
export interface HuntMatchFixture {
  canonicalTracks: Array<{ title: string }>;
  rawResponses: SlskdSearchResponse[];
  expected: { correctFolder: FolderRef | null };
  meta: {
    id: number;
    verdict: GenerationVerdict;
    artistName: string;
    albumTitle: string;
  };
}
