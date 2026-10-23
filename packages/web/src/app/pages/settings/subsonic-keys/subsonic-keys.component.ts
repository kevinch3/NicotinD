import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SubsonicKeysApiService } from '../../../services/api/subsonic-keys-api.service';
import type { SubsonicKeyMintResponse, SubsonicKeyRow } from '../../../services/api/api-types';
import { AuthService } from '../../../services/auth.service';
import { ServerConfigService } from '../../../services/server-config.service';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TranslateService } from '../../../services/translate.service';

/**
 * Mint/list/revoke OpenSubsonic API keys (docs/opensubsonic.md) — what a
 * Subsonic app (Music Assistant, Symfonium, Feishin…) signs in to `/rest` with.
 * Any role: a key only ever acts as its owner.
 */
@Component({
  selector: 'app-subsonic-keys',
  imports: [
    RouterLink,
    FormsModule,
    TvNavGroupDirective,
    TvNavItemDirective,
    SettingsGroupComponent,
    TranslatePipe,
  ],
  templateUrl: './subsonic-keys.component.html',
})
export class SubsonicKeysComponent implements OnInit {
  private api = inject(SubsonicKeysApiService);
  private readonly i18n = inject(TranslateService);
  private readonly serverConfig = inject(ServerConfigService);
  readonly auth = inject(AuthService);

  readonly keys = signal<SubsonicKeyRow[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  /** The just-minted secret — shown once, then never retrievable again. */
  readonly minted = signal<SubsonicKeyMintResponse | null>(null);
  readonly copied = signal('');
  /** The address a Subsonic app connects to: the configured server in the
   *  native shells, this page's origin on the web. */
  readonly serverUrl = computed(() => this.serverConfig.baseUrl() || window.location.origin);

  name = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.listKeys().subscribe({
      next: (res) => this.keys.set(res.keys),
      error: () => this.error.set(this.i18n.t('subsonicKeys.errorLoad')),
    });
  }

  mint(): void {
    const name = this.name.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.mintKey(name).subscribe({
      next: (res) => {
        this.minted.set(res);
        this.name = '';
        this.busy.set(false);
        this.load();
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.i18n.t('subsonicKeys.errorCreate'));
      },
    });
  }

  revoke(key: SubsonicKeyRow): void {
    this.api.revokeKey(key.id).subscribe({
      next: () => this.keys.update((list) => list.filter((k) => k.id !== key.id)),
      error: () => this.error.set(this.i18n.t('subsonicKeys.errorRevoke')),
    });
  }

  dismissMinted(): void {
    this.minted.set(null);
  }

  /** Copy `text`; `which` names the button that shows "Copied!". */
  copy(text: string, which: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(which);
      setTimeout(() => this.copied.set(''), 1500);
    });
  }

  formatWhen(ms: number | null): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString();
  }
}
