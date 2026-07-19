import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { toDataURL } from 'qrcode';
import { AuthService } from '../../../services/auth.service';
import { DevicesApiService } from '../../../services/api/devices-api.service';
import type {
  PairedDevice,
  PairingMintResponse,
  RemoteAccessStatus,
} from '../../../services/api/api-types';
import { buildPairingLink } from '../../../lib/pairing';
import { isNativePlatform } from '../../../lib/platform';

/**
 * "Link a device" — pair a phone to this server by QR (or manual URL + code)
 * and manage the resulting paired devices. The remote-access panel (admin)
 * drives the guided Tailscale-Funnel state machine so the server is reachable
 * from outside the machine it runs on.
 */
@Component({
  selector: 'app-devices',
  imports: [RouterLink],
  templateUrl: './devices.component.html',
})
export class DevicesComponent implements OnInit, OnDestroy {
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
   * On the phone app the QR exists to be scanned BY a phone, so auto-minting
   * and showing it front-and-center is noise (you can't scan your own screen).
   * It stays available behind a "Link another device" expander for the
   * second-phone case; desktop/web keep the always-open auto-minting panel.
   */
  readonly onNativeApp = isNativePlatform();
  readonly linkPanelOpen = signal(!isNativePlatform());

  ngOnInit(): void {
    if (this.linkPanelOpen()) this.regenerate();
    this.loadDevices();
    if (this.auth.isAdmin()) {
      this.api.getRemoteAccess().subscribe({
        next: (status) => this.remote.set(status),
        error: () => {},
      });
    }
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
      error: () => this.error.set('Could not create a pairing code'),
    });
  }

  /** Expand the mobile "Link another device" panel, minting on first open. */
  openLinkPanel(): void {
    if (this.linkPanelOpen()) return;
    this.linkPanelOpen.set(true);
    this.regenerate();
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
      error: () => this.error.set('Could not revoke device'),
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
        this.error.set('Could not update remote access');
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
