import { firstValueFrom } from 'rxjs';
import type { DownloadsApiService } from '../services/api/downloads-api.service';
import { huntCutShort, type FolderCandidate } from '../services/api/api-types';
import { mergeCandidates } from './merge-candidates';

export type HuntPhase = 'base' | 'skew';
export type HuntPhaseState = 'searching' | 'done' | 'skipped';

export interface ScoredHunt {
  candidates: FolderCandidate[];
  totalTracks: number;
  rateLimited: boolean;
  sourceOffline: boolean;
  /** Some searches never ran (#1049): retriable now, no evidence about the album. */
  cutShort: boolean;
  searchesFired: number;
  searchesAnswered: number;
}

/**
 * The scored album hunt every picker runs: the base queries, then the skewed
 * variants only when the base found no confident match, merged and re-ranked.
 * `onBase` hands over the base candidates so a surface can show them while the
 * skew phase is still out.
 */
export async function runScoredHunt(
  api: DownloadsApiService,
  lidarrAlbumId: number,
  artistName: string,
  albumTitle: string,
  opts: {
    skew: boolean;
    localAlbumId?: string;
    onPhase?: (phase: HuntPhase, state: HuntPhaseState) => void;
    onBase?: (candidates: FolderCandidate[], totalTracks: number) => void;
  },
): Promise<ScoredHunt> {
  opts.onPhase?.('base', 'searching');
  const base = await firstValueFrom(
    api.huntAlbumBase(lidarrAlbumId, {
      artistName,
      albumTitle,
      skewSearch: opts.skew,
      ...(opts.localAlbumId ? { localAlbumId: opts.localAlbumId } : {}),
    }),
  );
  opts.onPhase?.('base', 'done');
  opts.onBase?.(base.candidates, base.totalTracks);

  const hunt: ScoredHunt = {
    candidates: base.candidates,
    totalTracks: base.totalTracks,
    rateLimited: !!base.rateLimited,
    sourceOffline: !!base.sourceOffline,
    cutShort: huntCutShort(base),
    searchesFired: base.searchesFired ?? 0,
    searchesAnswered: base.searchesAnswered ?? 0,
  };
  if (!opts.skew) return hunt;
  if (!base.skewNeeded) {
    opts.onPhase?.('skew', 'skipped');
    return hunt;
  }

  opts.onPhase?.('skew', 'searching');
  const skew = await firstValueFrom(api.huntAlbumSkew(lidarrAlbumId, { artistName, albumTitle }));
  opts.onPhase?.('skew', 'done');
  return {
    ...hunt,
    candidates: mergeCandidates(base.candidates, skew.candidates),
    rateLimited: hunt.rateLimited || !!skew.rateLimited,
    sourceOffline: hunt.sourceOffline || !!skew.sourceOffline,
    cutShort: hunt.cutShort || huntCutShort(skew),
    searchesFired: hunt.searchesFired + (skew.searchesFired ?? 0),
    searchesAnswered: hunt.searchesAnswered + (skew.searchesAnswered ?? 0),
  };
}

const toFiles = (c: FolderCandidate) =>
  c.files.map((f) => ({ filename: f.filename, size: f.size }));

/**
 * The hunt-download body for one pick: the other candidates ride along as
 * ranked alternates, so the server can recover a track this peer fails on.
 */
export function huntDownloadPayload(
  pick: FolderCandidate,
  all: readonly FolderCandidate[],
  localAlbumId?: string,
) {
  return {
    selected: {
      username: pick.username,
      directory: pick.directory,
      files: toFiles(pick),
      candidateRef: pick.candidateRef,
    },
    alternates: all
      .filter((c) => c !== pick)
      .map((c) => ({ username: c.username, directory: c.directory, files: toFiles(c) })),
    localAlbumId,
  };
}
