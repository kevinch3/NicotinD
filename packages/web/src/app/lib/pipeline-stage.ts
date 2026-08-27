import type { PipelineStage } from '@nicotind/core';

/** Human label + semantic tone for a pipeline stage chip. */
export interface StageBadge {
  /**
   * i18n key for the label. The acquire lane is still largely hardcoded
   * English (#664); new strings land as keys from the start so that sweep has
   * one less constant to find.
   */
  key: string;
  /** English text, and the fallback when no catalog has the key. */
  label: string;
  /** Coarse tone the component maps to theme classes. */
  tone: 'active' | 'pending' | 'error' | 'done';
}

const BADGES: Record<PipelineStage, StageBadge> = {
  // Distinct from `queued` on purpose (#711): "waiting behind other work" and
  // "we have not been told what this link contains yet" are different facts,
  // and only the second explains a card showing no track count.
  resolving: { key: 'downloads.stage.resolving', label: 'Resolving link…', tone: 'pending' },
  queued: { key: 'downloads.stage.queued', label: 'Queued', tone: 'pending' },
  downloading: { key: 'downloads.stage.downloading', label: 'Downloading', tone: 'active' },
  organizing: { key: 'downloads.stage.organizing', label: 'Organizing', tone: 'active' },
  scanning: { key: 'downloads.stage.scanning', label: 'Scanning', tone: 'active' },
  processing: { key: 'downloads.stage.processing', label: 'Processing', tone: 'active' },
  done: { key: 'downloads.stage.done', label: 'Done', tone: 'done' },
  error: { key: 'downloads.stage.error', label: 'Error', tone: 'error' },
};

export function stageBadge(stage: PipelineStage): StageBadge {
  return BADGES[stage] ?? BADGES.queued;
}

/** Ordered stages shown in the stepper (terminal `error` is rendered inline). */
export const STAGE_STEPS: readonly PipelineStage[] = [
  'resolving',
  'queued',
  'downloading',
  'organizing',
  'scanning',
  'processing',
  'done',
];

/** Zero-based index of a stage in the linear pipeline (error → -1). */
export function stageIndex(stage: PipelineStage): number {
  return STAGE_STEPS.indexOf(stage);
}
