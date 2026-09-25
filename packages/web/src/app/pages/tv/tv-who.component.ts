import { Component, inject } from '@angular/core';
import { TvProfileService } from '../../services/tv-profile.service';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * "Who's listening?" (#1406): the people this TV knows on this server, one
 * D-pad row each, then Add person. Server-guarded only and outside the TV
 * shell (no status line): it must work with no session, because switching IS
 * the login. Reached from Home's nav, from /login's back-link, and after a
 * refused switch while other people remain.
 */
@Component({
  selector: 'app-tv-who',
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-who.component.html',
})
export class TvWhoComponent {
  readonly profiles = inject(TvProfileService);

  pick(username: string): void {
    void this.profiles.switchTo(username);
  }
}
