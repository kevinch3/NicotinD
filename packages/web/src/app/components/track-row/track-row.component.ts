import { Component, computed, inject, input, output } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../artist-links/artist-links.component';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';
import { PlayerService, type Track } from '../../services/player.service';
import { rowPlaybackState } from '../../lib/row-playback-state';
import type { ArtistCredit } from '../../services/api/api-types';

export interface TrackAction {
  label: string;
  icon?: string;
  action: () => void;
  destructive?: boolean;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-track-row',
  imports: [CoverArtComponent, ArtistLinksComponent, MenuPanelComponent],
  templateUrl: './track-row.component.html',
})
export class TrackRowComponent {
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);

  readonly track = input.required<Track>();
  readonly indexLabel = input<string | number>();
  readonly subtitle = input<string>();
  readonly duration = input<number>();
  readonly disabled = input(false);
  readonly showRemove = input(false);
  readonly offline = input(false);
  /**
   * When false, the per-track cover thumbnail is hidden. Set this in a
   * single-album context (album/EP detail) where every row shares the same
   * cover — the track number already identifies the row, so rendering ~12–20
   * identical thumbnails is wasted cover fetches/decodes. Defaults true for
   * mixed-album lists (playlists, artist Songs, search, queue).
   */
  readonly showCover = input(true);
  /** When true, the row shows a checkbox (multi-select mode) reflecting `selected`. */
  readonly selectable = input(false);
  readonly selected = input(false);
  readonly artists = input<ArtistCredit[]>();
  readonly actions = input<TrackAction[]>([]);
  readonly play = output<void>();
  readonly remove = output<void>();
  /** Emits the originating click so hosts can detect shift-click range selection. */
  readonly selectedChange = output<MouseEvent>();

  // Current-track indicator: currentTrack is set synchronously on click, so the
  // row acknowledges a tap instantly — before any (HDD-slow) bytes arrive.
  readonly playbackState = computed(() =>
    rowPlaybackState(
      this.player.currentTrack()?.id,
      this.track().id,
      this.player.bufferingVisible(),
      this.player.isPlaying(),
    ),
  );
  readonly isCurrent = computed(() => this.playbackState() !== null);

  // Menu open/close/positioning is delegated to MenuPanelComponent (viewport-safe
  // + bottom-chrome aware); the row only runs the chosen action. The template
  // closes the panel via its template ref before invoking this.
  runAction(action: TrackAction) {
    action.action();
  }

  formatDuration = formatDuration;
}
