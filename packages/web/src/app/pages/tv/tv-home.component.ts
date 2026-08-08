import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
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
      <app-radio-landing />

      <nav appTvNavGroup [axis]="'horizontal'" class="flex gap-4" data-testid="tv-home-nav">
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
    </div>
  `,
})
export class TvHomeComponent {}
