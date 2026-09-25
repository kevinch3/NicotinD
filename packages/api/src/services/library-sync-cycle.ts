import { yieldToEventLoop } from './loop-block-monitor.js';

export interface LibrarySyncCycleSteps {
  scanFull: () => Promise<unknown>;
  reclassifyAll: () => void;
  /** Best-effort acquisition provenance for songs that predate the table. */
  backfillAcquisitions: () => void;
  /** Nudge enrichment for anything the scan brought in. Not awaited. */
  kickEnrichment: () => void;
}

/**
 * One full sync + curate cycle. Each step is synchronous or ends in one, so
 * back to back they were a single event-loop block — ~3.9 s at boot on prod
 * (#1313). The loop gets a turn between steps; the steps and their order are
 * unchanged.
 */
export async function runLibrarySyncCycle(steps: LibrarySyncCycleSteps): Promise<void> {
  await steps.scanFull();
  await yieldToEventLoop();
  steps.reclassifyAll();
  await yieldToEventLoop();
  steps.backfillAcquisitions();
  steps.kickEnrichment();
}
