import { Component, computed, inject } from '@angular/core';
import { Location } from '@angular/common';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The 10-foot player, as a route rather than a sheet.
 *
 * On the phone Now Playing is a sheet inside the layout, permanently mounted
 * and translated off-screen — which is what let its blurred backdrop bleed over
 * every other route (#439). Here it is an ordinary route: it exists when you're
 * looking at it and not otherwise, so the translate machinery, the drag-to-open
 * gesture, the grab notch and the `html.tv-build` sheet overrides all become
 * unnecessary.
 *
 * There is deliberately **no seek bar**: a native range input eats all four
 * arrow keys and a remote has no Tab to escape with (#438). ◀ ▶ seek instead,
 * bound by `KeyboardShortcutsService` only while this route is active.
 */
@Component({
  selector: 'app-tv-player',
  standalone: true,
  imports: [CoverArtComponent, TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-player.component.html',
})
export class TvPlayerComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private readonly location = inject(Location);

  readonly track = this.player.currentTrack;
  readonly nextUp = computed(() => this.player.queue()[0] ?? null);

  /** Blurred cover behind the sheet. Safe to bind unconditionally here — unlike
   *  the phone sheet, this component only exists while the route is active. */
  readonly backdrop = computed(() => {
    const art = this.track()?.coverArt;
    return art ? `url(/api/cover/${art}?size=600&token=${this.auth.token()})` : null;
  });

  togglePlay(): void {
    if (this.player.isPlaying()) this.player.pause();
    else this.player.resume();
  }

  back(): void {
    this.location.back();
  }
}
