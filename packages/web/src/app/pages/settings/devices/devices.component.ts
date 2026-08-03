import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { DevicesApiService } from '../../../services/api/devices-api.service';
import type {
  PairedDevice,
  PairingMintResponse,
  RemoteAccessStatus,
} from '../../../services/api/api-types';
import { buildPairingLink } from '../../../lib/pairing';
import { isNativePlatform } from '../../../lib/platform';
import { TranslateService } from '../../../services/translate.service';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';

/**
 * "Link a device" — pair a phone to this server by QR (or manual URL + code)
 * and manage the resulting paired devices. The remote-access panel (admin)
 * drives the guided Tailscale-Funnel state machine so the server is reachable
 * from outside the machine it runs on.
 */
@Component({
  selector: 'app-devices',
  imports: [
    RouterLink,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
    SettingsGroupComponent,
  ],
  templateUrl: './devices.component.html',
})
export class DevicesComponent implements OnInit, OnDestroy {
  readonly i18n = inject(TranslateService);
  private api = inject(DevicesApiService);
  readonly auth = inject(AuthService);

  readonly pairing = signal<PairingMintResponse | null>(null);
  readonly qrDataUrl = signal<string | null>(null);
  readonly secondsLeft = signal(0);
  readonly devices = signal<PairedDevice[]>([]);
  readonly remote = signal<RemoteAccessStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly copied = signal(false);

  private countdown: ReturnType<typeof setInterval> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Every settings-group card is collapsed by default with no exception
   * (project-wide decision) — so the "Link device" card no longer
   * auto-expands on web/desktop the way its pre-migration `linkPanelOpen`
   * signal did. `onNativeApp` still distinguishes the copy ("Link a device"
   * vs "Link another device" — the phone app's job is to *scan* QRs, not
   * lead with one) and which scan-instructions string to show, but no longer
   * drives a `defaultOpen`. Minting happens in `onLinkOpened()`, driven by
   * the group's `(opened)` output, so nothing mints on page load — only the
   * first time a user actually expands the card.
   */
  readonly onNativeApp = isNativePlatform();

  ngOnInit(): void {
    this.loadDevices();
    if (this.auth.isAdmin()) {
      this.api.getRemoteAccess().subscribe({
        next: (status) => this.remote.set(status),
        error: () => {},
      });
    }
  }

  /** Mints a pairing code the moment the Link device group becomes open
   * (including a restored-open/defaultOpen resolution at init) — but never
   * re-mints if a code already exists (e.g. a re-open after collapsing). */
  onLinkOpened(): void {
    if (!this.pairing()) this.regenerate();
  }

  ngOnDestroy(): void {
    if (this.countdown) clearInterval(this.countdown);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }

  regenerate(): void {
    this.error.set('');
    this.api.mintPairing().subscribe({
      next: (mint) => {
        this.pairing.set(mint);
        if (mint.remoteAccess) this.remote.set(mint.remoteAccess);
        this.startCountdown(mint.expiresAt);
        void this.renderQr(mint);
      },
      error: () => this.error.set(this.i18n.t('devices.errorCreatePairing')),
    });
  }

  private async renderQr(mint: PairingMintResponse): Promise<void> {
    if (mint.urls.length === 0) {
      this.qrDataUrl.set(null);
      return;
    }
    // The QR encodes a `/pair#t=…` link (not raw JSON) so a plain camera app
    // can act on it too — it opens the server's own pairing page in a browser.
    const payload = buildPairingLink({ name: mint.name, urls: mint.urls, token: mint.token });
    try {
      // Dynamic import: `qrcode` is CommonJS, which esbuild reports as an
      // optimization bailout ("Module 'qrcode' … is not ESM") when statically
      // imported. Loading it here also keeps it out of this route's chunk until
      // a pairing QR is actually requested — it is needed once, on one click.
      const { toDataURL } = await import('qrcode');
      this.qrDataUrl.set(await toDataURL(payload, { margin: 1, width: 240 }));
    } catch {
      this.qrDataUrl.set(null);
    }
  }

  private startCountdown(expiresAt: number): void {
    if (this.countdown) clearInterval(this.countdown);
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      this.secondsLeft.set(left);
      if (left === 0 && this.countdown) clearInterval(this.countdown);
    };
    tick();
    this.countdown = setInterval(tick, 1000);
  }

  loadDevices(): void {
    this.api.getDevices().subscribe({
      next: (res) => this.devices.set(res.devices),
      error: () => {},
    });
  }

  revoke(device: PairedDevice): void {
    this.api.revokeDevice(device.id).subscribe({
      next: () => this.devices.update((list) => list.filter((d) => d.id !== device.id)),
      error: () => this.error.set(this.i18n.t('devices.errorRevoke')),
    });
  }

  toggleRemoteAccess(): void {
    const current = this.remote();
    if (!current || this.busy()) return;
    this.setRemoteAccess(!current.enabled);
  }

  /** Re-arm after the user completed a guided step (operator/login/funnel
   * approval) without making them toggle Off and On. */
  retryRemoteAccess(): void {
    if (this.busy()) return;
    this.setRemoteAccess(true);
  }

  private setRemoteAccess(enabled: boolean): void {
    this.busy.set(true);
    this.api.setRemoteAccess(enabled).subscribe({
      next: (status) => {
        this.remote.set(status);
        this.busy.set(false);
        // The candidate URLs in the QR change with funnel state — remint.
        this.regenerate();
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.i18n.t('devices.errorRemoteAccess'));
      },
    });
  }

  copyCommand(command: string): void {
    void navigator.clipboard?.writeText(command).then(() => {
      this.copied.set(true);
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), 1500);
    });
  }

  formatWhen(ms: number | null): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString();
  }
}
