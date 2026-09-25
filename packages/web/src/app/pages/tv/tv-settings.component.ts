import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { APP_VERSION } from '../../app.config';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '../../services/translate.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
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
  readonly auth = inject(AuthService);
  readonly version = inject(APP_VERSION);
  private readonly router = inject(Router);
  readonly i18n = inject(TranslateService);

  readonly chooser = signal<Chooser>(null);
  private readonly remote = inject(RemotePlaybackService);
  private readonly ws = inject(PlaybackWsService);
  readonly remoteEnabled = this.remote.outputAvailable;

  /** The name this TV advertises in every other device's picker. It is
   *  special-cased ("NicotinD TV" — the UA reads "Chrome on Android" and says
   *  nothing a cast selector needs, #393), and until now it was visible only
   *  from the phone settings page: from the couch there was no way to tell
   *  which entry in the picker was this box (#1128). */
  readonly deviceName = computed(
    () =>
      this.remote.devices().find((d) => d.id === this.ws.getDeviceId())?.name ??
      this.ws.getDeviceName(),
  );

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
    // Through the service, so the server hears it now rather than at the next
    // REGISTER, and the web settings page agrees.
    this.remote.setOutputAvailable(enabled);
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
