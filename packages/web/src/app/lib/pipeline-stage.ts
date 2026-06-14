import type { PipelineStage } from '@nicotind/core';

/** Human label + semantic tone for a pipeline stage chip. */
export interface StageBadge {
  label: string;
  /** Coarse tone the component maps to theme classes. */
  tone: 'active' | 'pending' | 'error' | 'done';
}

const BADGES: Record<PipelineStage, StageBadge> = {
  queued: { label: 'Queued', tone: 'pending' },
  downloading: { label: 'Downloading', tone: 'active' },
  organizing: { label: 'Organizing', tone: 'active' },
  scanning: { label: 'Scanning', tone: 'active' },
  done: { label: 'Done', tone: 'done' },
  error: { label: 'Error', tone: 'error' },
};

export function stageBadge(stage: PipelineStage): StageBadge {
  return BADGES[stage] ?? BADGES.queued;
}

/** Ordered stages shown in the stepper (terminal `error` is rendered inline). */
export const STAGE_STEPS: readonly PipelineStage[] = [
  'queued',
  'downloading',
  'organizing',
  'scanning',
  'done',
];

/** Zero-based index of a stage in the linear pipeline (error → -1). */
export function stageIndex(stage: PipelineStage): number {
  return STAGE_STEPS.indexOf(stage);
}
