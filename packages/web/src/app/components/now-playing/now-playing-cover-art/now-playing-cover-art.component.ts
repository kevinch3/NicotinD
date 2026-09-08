import { Component, computed, inject, input, output, viewChild } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { LikeService } from '../../../services/like.service';
import { ReportTrackService } from '../../../services/report-track.service';
import { SongMenuService } from '../../../services/song-menu.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../../artist-links/artist-links.component';
import { EntityLinkComponent } from '../../entity-link/entity-link.component';
import { MenuPanelComponent } from '../../menu-panel/menu-panel.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { formatQuality } from '../../../lib/download-status';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { isTvUi } from '../../../lib/platform';

@Component({
  selector: 'app-now-playing-cover-art',
  imports: [
    CoverArtComponent,
    ArtistLinksComponent,
    EntityLinkComponent,
    MenuPanelComponent,
    TranslatePipe,
    TvNavItemDirective,
  ],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-cover-art.component.html',
})
export class NowPlayingCoverArtComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly likes = inject(LikeService);
  readonly report = inject(ReportTrackService);
  private readonly songMenu = inject(SongMenuService);

  private readonly menu = viewChild(MenuPanelComponent);

  /** The same list every track row shows — `Track` is `BaseSong` plus an
   *  optional `queuedBy`, so the current track passes straight through. */
  readonly menuActions = computed(() => {
    const track = this.player.currentTrack();
    return track ? this.songMenu.build(track) : [];
  });

  // TV-hidden, mirroring now-playing-transport's shuffle/repeat cut (D-pad
  // economy) — the root nav group's ArrowUp order is a fixed sequence
  // (playpause → track info → next-up chip → close, see
  // now-playing-tv.spec.ts), so inserting another direct item here would
  // shift every step of it. Like stays reachable on TV via the track row /
  // ⋯ menu.
  readonly isTv = isTvUi();

  readonly coverMaxPx = input<number>(320);
  readonly resizing = input(false);

  /** Fully dragged away — the wrapper drops its padding so no empty band remains. */
  readonly coverCollapsed = computed(() => this.coverMaxPx() <= 0);

  readonly openTrackInfo = output<string>();
  readonly navigateToArtistClicked = output<void>();
  /** The album link under the artist line was followed — the sheet should close. */
  readonly navigateToAlbumClicked = output<void>();

  formatQuality(bitrateKbps?: number | null): string {
    return formatQuality(bitrateKbps, null);
  }

  toggleLike(id: string): void {
    void this.likes.toggle(id);
  }

  /** Right-click keeps working, but it now opens the same ⋯ panel the button
   *  does — one menu in the sheet, not two (issue #1038). Anchored to the
   *  trigger rather than the pointer, so the menu lands in one known place. */
  onTitleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (!this.isTv) this.menu()?.toggle(event);
  }
}
