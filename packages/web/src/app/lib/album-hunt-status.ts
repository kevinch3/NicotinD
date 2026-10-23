import type { PipelineStage } from '@nicotind/core';
import { stageLabel } from './pipeline-stage';

/**
 * Where one album is in its acquisition: nothing, a click with no job visible
 * yet, or a live job — from any lane (a catalog card, a peer folder, the
 * auto-acquire poller), since every surface showing the album asks by the same
 * identity (#1539). Per album — a hunt never blocks a different album.
 */
export type AlbumHuntStatus =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | {
      phase: 'job';
      stage: PipelineStage;
      /** The live job, so a surface can link to it in Downloads. */
      jobId?: string;
      /** Tracks on disk / the job's denominator; absent until the job commits one. */
      delivered?: number;
      expected?: number;
    };

export const IDLE_HUNT: AlbumHuntStatus = { phase: 'idle' };
export const SEARCHING_HUNT: AlbumHuntStatus = { phase: 'searching' };

/**
 * The one busy label every Get surface shows — "Finding…", or the job's stage
 * with its progress ("Downloading · 7/13") so a card says how far along it is
 * rather than only that it is busy.
 */
export function albumHuntLabel(status: AlbumHuntStatus, t: (key: string) => string): string {
  if (status.phase !== 'job') {
    // English fallback for an unloaded key, the way `stageLabel` does it.
    const finding = t('acquire.finding');
    return finding === 'acquire.finding' ? 'Finding…' : finding;
  }
  const stage = stageLabel(status.stage, t);
  return status.expected ? `${stage} · ${status.delivered ?? 0}/${status.expected}` : stage;
}
