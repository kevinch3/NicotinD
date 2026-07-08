import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService, THEME_PRESETS } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService, UNLIMITED_BUDGET } from '../../services/preserve.service';
import { ChangelogModalComponent } from '../../components/changelog-modal/changelog-modal.component';
import { APP_VERSION } from '../../app.config';
import {
  MediaControlsService,
  type NowPlayingDiagnostics,
} from '../../services/media-controls.service';
import { isIosNative } from '../../lib/platform';

const GB = 1024 * 1024 * 1024;

/** Selectable offline storage budgets (bytes). */
export const BUDGET_OPTIONS: { label: string; bytes: number }[] = [
  { label: '1 GB', bytes: 1 * GB },
  { label: '2 GB', bytes: 2 * GB },
  { label: '5 GB', bytes: 5 * GB },
  { label: '10 GB', bytes: 10 * GB },
  { label: 'Unlimited', bytes: UNLIMITED_BUDGET },
];

/**
 * User-scoped preferences only. Server-admin tools (streaming, library
 * processing, maintenance) live on the Admin page, and extension config (slskd
 * connection/shares/status) lives on each extension's own page under Extensions.
 * Keeping this page free of admin/extension coupling is the point of the
 * refactor — it renders identically for every user.
 */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, ChangelogModalComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  readonly auth = inject(AuthService);
  readonly themeService = inject(ThemeService);
  private router = inject(Router);
  readonly remote = inject(RemotePlaybackService);
  readonly preserve = inject(PreserveService);
  private ws = inject(PlaybackWsService);
  private mediaControls = inject(MediaControlsService);

  /** The Now Playing diagnostics panel only exists in the native iOS shell. */
  readonly isNativeIos = isIosNative();
  readonly nowPlayingDiag = signal<NowPlayingDiagnostics | null>(null);
  readonly nowPlayingDiagLoading = signal(false);

  readonly budgetOptions = BUDGET_OPTIONS;
  readonly themePresets = THEME_PRESETS;
  readonly myDeviceId = this.ws.getDeviceId();
  readonly version = inject(APP_VERSION);
  readonly showChangelog = signal(false);
  readonly showLogoutDialog = signal(false);
  readonly cleanPreserveOnLogout = signal(false);

  readonly deviceName = signal(this.ws.getDeviceName());
  readonly deviceNameSaved = signal(false);

  isAdmin(): boolean {
    return this.auth.role() === 'admin';
  }

  async refreshNowPlayingDiagnostics(): Promise<void> {
    this.nowPlayingDiagLoading.set(true);
    try {
      this.nowPlayingDiag.set(await this.mediaControls.getDiagnostics());
    } finally {
      this.nowPlayingDiagLoading.set(false);
    }
  }

  formatStorage(bytes: number): string {
    if (bytes >= UNLIMITED_BUDGET) return '∞';
    if (bytes < GB) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;
  }

  usagePercent(): number {
    const budget = this.preserve.budget();
    if (budget <= 0) return 0;
    return Math.min(100, (this.preserve.totalUsage() / budget) * 100);
  }

  logout(): void {
    if (this.preserve.totalUsage() > 0) {
      this.cleanPreserveOnLogout.set(false);
      this.showLogoutDialog.set(true);
    } else {
      this.auth.logout();
      this.router.navigateByUrl('/login');
    }
  }

  async confirmLogout(): Promise<void> {
    if (this.cleanPreserveOnLogout()) {
      await this.preserve.clearAll();
    }
    this.showLogoutDialog.set(false);
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }

  async toggleRemote(): Promise<void> {
    const enabled = !this.remote.remoteEnabled();
    if (enabled) {
      const audio = document.querySelector('audio');
      if (audio && audio.paused) {
        try {
          await audio.play();
          audio.pause();
        } catch {
          /* ignore */
        }
      }
    }
    this.remote.setRemoteEnabled(enabled);
  }

  saveDeviceName(): void {
    if (!this.deviceName().trim()) return;
    this.ws.setDeviceName(this.deviceName().trim());
    this.deviceNameSaved.set(true);
  }

  getDeviceEmoji(device: { type: string; name: string }): string {
    if (device.type !== 'web') return '🎵';
    return /iPhone|iPad|Android/i.test(device.name) ? '📱' : '🖥️';
  }
}
