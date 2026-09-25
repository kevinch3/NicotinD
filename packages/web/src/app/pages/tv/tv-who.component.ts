import { Component, inject } from '@angular/core';
import { TvProfileService } from '../../services/tv-profile.service';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * "Who's listening?" (#1406): the people this TV knows, one D-pad row each,
 * then Add person. Also the front door when the box has people but no active
 * session (after a sign-out or an abandoned Add), which is why the route is
 * server-guarded only — switching IS the login.
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
