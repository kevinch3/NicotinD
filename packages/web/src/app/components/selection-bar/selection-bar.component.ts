import { Component, inject, input, output } from '@angular/core';
import { EntityMenuService } from '../../services/entity-menu.service';
import type { TrackAction } from '../track-row/track-row.component';
import { IconComponent } from '../icon/icon.component';

/**
 * Action bar shown while a track list is in multi-select mode. Stateless —
 * the host page owns the `Selection` (see `lib/selection.ts`) and feeds `count`
 * + `total`; this just renders the controls and emits intent.
 */
@Component({
  selector: 'app-selection-bar',
  imports: [IconComponent],
  templateUrl: './selection-bar.component.html',
})
export class SelectionBarComponent {
  readonly count = input(0);
  readonly total = input(0);
  /** Show a destructive Delete button (host decides the semantics + gating). */
  readonly canDelete = input(false);
  readonly deleteLabel = input('Delete');
  // Optional bulk actions — off by default so existing hosts (e.g. playlist
  // detail, which only wants Add-to-playlist + Delete) render unchanged. The
  // artist Songs tab opts into the full set.
  readonly canPlay = input(false);
  readonly canQueue = input(false);
  readonly canDownload = input(false);
  /** Show a "Save offline" bulk action — distinct from `canDownload` (network download). */
  readonly canPreserve = input(false);

  /** The bulk song menu (`SongMenuService.buildMany`); its `⋯` shows when set (#2012). */
  readonly moreActions = input<TrackAction[] | null>(null);
  private readonly entityMenu = inject(EntityMenuService);

  openMore(anchor: HTMLElement): void {
    const actions = this.moreActions();
    if (actions?.length) this.entityMenu.open({ actions, anchor });
  }

  readonly selectAll = output<void>();
  readonly play = output<void>();
  readonly queue = output<void>();
  readonly add = output<void>();
  readonly download = output<void>();
  readonly preserve = output<void>();
  readonly deleteSelected = output<void>();
  readonly cancel = output<void>();
}
