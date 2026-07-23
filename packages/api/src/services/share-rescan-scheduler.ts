import { createLogger } from '@nicotind/core';

const log = createLogger('share-rescan-scheduler');

/**
 * Deleting a library file doesn't tell slskd — it keeps its own share index
 * and only rebuilds it on an explicit rescan (`shares.rescan()`, otherwise a
 * manual admin-only action). Left unrescanned, a deleted-but-still-shared file
 * makes every peer download attempt fail with "File not shared" indefinitely.
 * `schedule()` coalesces a burst of deletes (an album, a bulk-delete) into one
 * rescan call after `debounceMs` of quiet, instead of one rescan per file.
 */
export class ShareRescanScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly rescan: () => Promise<void>,
    options: { debounceMs?: number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 5_000;
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rescan().catch((err) => log.warn({ err }, 'slskd share rescan failed'));
    }, this.debounceMs);
  }
}
