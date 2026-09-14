import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { RadioLandingComponent } from '../radio-landing/radio-landing.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The TV front door: moods, then two ways out.
 *
 * The vibe content is `RadioLandingComponent` verbatim — it was already the
 * strongest thing in the TV build (one press to play, big targets), so this
 * wraps rather than reimplements it. Only the surrounding chrome is new.
 */
@Component({
  selector: 'app-tv-home',
  standalone: true,
  imports: [
    RadioLandingComponent,
    RouterLink,
    TvNavGroupDirective,
    TvNavItemDirective,
    TranslatePipe,
  ],
  template: `
    <div class="px-[4vw] py-[3vh] flex flex-col gap-8" data-testid="tv-home">
      <!-- The nav comes FIRST. Below the shelves it sat at y≈614 on a 540px TV
           viewport — the only two ways off the front door, and the way back to
           the player, were below the fold until the D-pad scrolled to them
           (#1135). A 10-foot UI shows its primary navigation before its
           content; leanback puts it at the top for the same reason. -->
      <nav appTvNavGroup [axis]="'horizontal'" class="flex gap-4" data-testid="tv-home-nav">
        <!-- Back to the player. Without it /player was reachable only by
             starting something: audio moved to a phone, or a cast landing
             here, left no way to the screen that says so (#1128). Hidden when
             nothing is loaded, so a fresh install shows two entries as before. -->
        @if (player.currentTrack()) {
          <a
            appTvNavItem
            routerLink="/player"
            data-testid="tv-nav-player"
            class="px-8 py-4 rounded-2xl bg-theme-surface-2 text-lg font-semibold
                   focus:outline-none focus-visible:ring-4 focus-visible:ring-theme-accent"
          >
            {{ 'tv.nowPlaying' | t }}
          </a>
        }
        <a
          appTvNavItem
          routerLink="/library"
          data-testid="tv-nav-browse"
          class="px-8 py-4 rounded-2xl bg-theme-surface-2 text-lg font-semibold
                 focus:outline-none focus-visible:ring-4 focus-visible:ring-theme-accent"
        >
          {{ 'nav.library' | t }}
        </a>
        <a
          appTvNavItem
          routerLink="/settings"
          data-testid="tv-nav-settings"
          class="px-8 py-4 rounded-2xl bg-theme-surface-2 text-lg font-semibold
                 focus:outline-none focus-visible:ring-4 focus-visible:ring-theme-accent"
        >
          {{ 'nav.settings' | t }}
        </a>
      </nav>

      <app-radio-landing />
    </div>
  `,
})
export class TvHomeComponent {
  readonly player = inject(PlayerService);
}
