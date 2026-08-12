import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { FallbackHost } from './album-fallback.service.js';
import {
  addonJobIdForAlbumJob,
  itemIdForTitle,
  recomputeJobState,
  repointJobItem,
  setItemState,
} from './job-store.js';

const log = createLogger('addon-fallback-host');

/**
 * The addon's own FallbackHost: fallback events land on the protocol job
 * ledger (`addon_jobs`), which the core host mirrors by polling. `onDiskTitles`
 * deliberately returns [] — the addon has no library; the host pre-filters via
 * `wantedTracks` at job creation, and the accepted staleness for *revived*
 * jobs is documented in docs/acquisition-addon-protocol.md.
 */
export function makeAddonFallbackHost(db: Database): FallbackHost {
  return {
    repointItems(albumJobId, username, items, audioFormat) {
      const jobId = addonJobIdForAlbumJob(db, albumJobId);
      if (!jobId) {
        log.warn({ albumJobId }, 'No addon job owns this album job — repoint dropped');
        return;
      }
      for (const { title, filename, bitRate } of items) {
        repointJobItem(db, jobId, itemIdForTitle(title), {
          username,
          filename,
          bitRateKbps: bitRate,
          audioFormat,
        });
      }
    },

    jobClosed(albumJobId, state) {
      const jobId = addonJobIdForAlbumJob(db, albumJobId);
      if (!jobId) return;
      if (state === 'exhausted') {
        // The still-missing tracks are unobtainable: flip every non-completed
        // item so the job resolves as an honest partial for the host.
        db.run(
          `UPDATE addon_job_items SET state = 'unavailable', updated_at = ?
           WHERE job_id = ? AND state NOT IN ('completed')`,
          [Date.now(), jobId],
        );
      }
      recomputeJobState(db, jobId);
    },

    onDiskTitles() {
      return [];
    },
  };
}

/** Re-exported for the engine's per-item failure marking. */
export { setItemState };
