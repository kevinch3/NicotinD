import type { Database } from 'bun:sqlite';
import { createLogger, normalizeTitle } from '@nicotind/core';
import type { FallbackHost } from '@nicotind/slskd-addon';
import { albumIdFor } from './library-scanner.js';
import {
  acquisitionJobIdForAlbumJob,
  markMissingItemsUnavailable,
  recomputeStage,
  repointOrAttachItem,
} from './acquisition-job-store.js';

const log = createLogger('fallback-host');

/**
 * The api's implementation of the fallback's host seam (see `FallbackHost` in
 * @nicotind/slskd-addon): unified-job repoints/closure over
 * acquisition-job-store, on-disk suppression over the library tables. This is
 * the exact behavior that lived inline in AlbumFallbackService before the
 * addon extraction (#488).
 */
export function makeApiFallbackHost(db: Database): FallbackHost {
  return {
    repointItems(albumJobId, username, items, audioFormat) {
      const acqJobId = acquisitionJobIdForAlbumJob(db, albumJobId);
      if (!acqJobId) {
        // A transfer NicotinD itself enqueued must never end up unlinked: the
        // enqueue already happened, so returning here orphans it permanently
        // and it renders as its own raw-folder card (issue #261). Nothing can
        // re-link it later, so at minimum make the loss visible.
        log.warn(
          { albumJobId, username, files: items.length },
          'No acquisition job owns this album job — enqueued transfers will be unlinked',
        );
        return;
      }
      for (const { title, filename, bitRate } of items) {
        repointOrAttachItem(db, acqJobId, title, username, filename, bitRate, audioFormat);
      }
    },

    jobClosed(albumJobId, state) {
      const acqJobId = acquisitionJobIdForAlbumJob(db, albumJobId);
      if (!acqJobId) return;
      if (state === 'exhausted') markMissingItemsUnavailable(db, acqJobId);
      recomputeStage(db, acqJobId);
    },

    onDiskTitles({ artistName, albumTitle }) {
      if (!artistName || !albumTitle) return [];
      const albumId = albumIdFor(artistName, albumTitle);
      const rows = db
        .query('SELECT title FROM library_songs WHERE album_id = ?')
        .all(albumId) as Array<{ title: string }>;
      return rows.map((r) => normalizeTitle(r.title));
    },
  };
}
