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
import { buildPairingPayload } from '../../../lib/pairing';

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

  private countdown: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.regenerate();
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

  private async renderQr(mint: PairingMintResponse): Promise<void> {
    if (mint.urls.length === 0) {
      this.qrDataUrl.set(null);
      return;
    }
    const payload = buildPairingPayload({ name: mint.name, urls: mint.urls, token: mint.token });
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
    this.busy.set(true);
    this.api.setRemoteAccess(!current.enabled).subscribe({
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

  formatWhen(ms: number | null): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString();
  }
}
