import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '../../services/translate.service';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Only what a TV needs: sign out, switch server, language, remote control.
 *
 * Every choice opens a **full-screen list of buttons**, never a `<select>`.
 * That is the whole point — a native control eats the arrow keys and a remote
 * has no Tab to escape one with (#438), so the TV tree contains no form
 * elements at all. `tests-tv/dpad-reachability.tv.spec.ts` asserts that.
 */
type Chooser = 'language' | 'remote' | null;

@Component({
  selector: 'app-tv-settings',
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-settings.component.html',
})
export class TvSettingsComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly i18n = inject(TranslateService);

  readonly chooser = signal<Chooser>(null);
  readonly remoteEnabled = signal(localStorage.getItem('nicotind_remote_enabled') !== 'false');

  open(which: Exclude<Chooser, null>): void {
    this.chooser.set(which);
  }

  close(): void {
    this.chooser.set(null);
  }

  chooseLanguage(lang: string): void {
    void this.i18n.use(lang);
    this.close();
  }

  chooseRemote(enabled: boolean): void {
    localStorage.setItem('nicotind_remote_enabled', String(enabled));
    this.remoteEnabled.set(enabled);
    this.close();
  }

  switchServer(): void {
    void this.router.navigate(['/server']);
  }

  signOut(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
