import type { PipelineStage } from '@nicotind/core';

/**
 * Where one album is in its hunt: nothing, a click with no job visible yet, or a
 * live acquisition job. Per album — a hunt never blocks a different album.
 */
export type AlbumHuntStatus =
  { phase: 'idle' } | { phase: 'searching' } | { phase: 'job'; stage: PipelineStage };

export const IDLE_HUNT: AlbumHuntStatus = { phase: 'idle' };
export const SEARCHING_HUNT: AlbumHuntStatus = { phase: 'searching' };
