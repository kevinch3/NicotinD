import { Component, input, output, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DownloadItem } from '../../lib/download-groups';
import { methodBadge } from '../../lib/acquisition-method';
import { resolveAlbumRoute } from '../../lib/route-utils';
import { PipelineStageBadgeComponent } from '../pipeline-stage-badge/pipeline-stage-badge.component';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';

/** Relative "Xm ago" from a ms timestamp. */
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

/**
 * Layout-critical classes for the row, exported and *bound* (not hardcoded in
 * the template) so the long-text truncation contract is unit-testable — the JIT
 * vitest harness can't drive a required `input()` into a render, so the spec
 * asserts these constants instead, and the template can't drift from them.
 *
 * - Host: the grid item in the Downloads feed. Without `block` it stays inline
 *   and sizes to content; without `min-w-0` a grid item refuses to shrink below
 *   its content's max width — either way the inner `overflow-hidden` never clips.
 * - Title: a flex item, which defaults to `min-width: auto`, so `truncate` is
 *   inert without `min-w-0`. That missing class is what let a long URL overflow.
 */
export const DOWNLOAD_ITEM_HOST_CLASS = 'block min-w-0';
export const DOWNLOAD_ITEM_TITLE_CLASS = 'text-sm text-theme-primary truncate min-w-0';

/**
 * Whether the row should offer an "Open in Library" deep-link: only once the
 * download is complete *and* we know the destination album id (hunt / URL
 * acquire; direct non-hunt Soulseek downloads have no id, so no link). Exported
 * so the gating contract is unit-testable without rendering the component.
 */
export function canOpenInLibrary(item: DownloadItem): boolean {
  return item.stage === 'done' && !!item.albumId;
}

/**
 * Whether the row should offer a "View N albums" menu instead: a completed
 * job whose files landed in more than one album (Task 1's `destinationAlbums`
 * — `albumId` is null in this case, so `canOpenInLibrary` is already false).
 * Exported so the gating contract is unit-testable without rendering.
 */
export function hasMultipleDestinationAlbums(item: DownloadItem): boolean {
  return item.stage === 'done' && (item.destinationAlbums?.length ?? 0) > 1;
}

/**
 * One row in the unified Downloads feed. Renders the four facets the user asked
 * for — how (method badge), what stage, when (started), where (storage path,
 * tucked behind a toggle) — plus, once complete, an "Open in Library" deep-link
 * to the destination album, and retry / cancel / remove controls that emit to
 * the parent, which dispatches by `item.kind`.
 */
@Component({
  selector: 'app-download-item',
  standalone: true,
  imports: [PipelineStageBadgeComponent, RouterLink, MenuPanelComponent],
  host: { '[class]': 'hostClass' },
  templateUrl: './download-item.component.html',
})
export class DownloadItemComponent {
  readonly hostClass = DOWNLOAD_ITEM_HOST_CLASS;
  readonly titleClass = DOWNLOAD_ITEM_TITLE_CLASS;

  readonly item = input.required<DownloadItem>();
  readonly retrying = input(false);

  readonly retry = output<void>();
  readonly cancel = output<void>();
  readonly remove = output<void>();

  readonly showPath = signal(false);

  readonly badge = computed(() => methodBadge(this.item().method));
  /** Whether to show the "Open in Library" deep-link on this row. */
  readonly canOpen = computed(() => canOpenInLibrary(this.item()));
  /** Deep-link target for the completed album ('/library' when the id is unknown). */
  readonly albumRoute = computed(() => resolveAlbumRoute(this.item().albumId));

  /** The destination albums to list in the "View N albums" menu, when shown. */
  readonly destinationAlbums = computed(() => this.item().destinationAlbums ?? []);
  /** Whether to show the "View N albums" menu on this row. */
  readonly showAlbumsMenu = computed(() => hasMultipleDestinationAlbums(this.item()));

  startedAgo(): string {
    const at = this.item().startedAt;
    return at ? timeAgo(at) : '';
  }

  /** Deep-link target for one destination album row in the "View N albums" menu. */
  albumRouteFor(albumId: string): string[] {
    return resolveAlbumRoute(albumId);
  }
}
