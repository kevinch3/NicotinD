import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService, THEME_PRESETS } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import {
  PreserveService,
  UNLIMITED_BUDGET,
  type AutoPreserveMode,
} from '../../services/preserve.service';
import { ChangelogModalComponent } from '../../components/changelog-modal/changelog-modal.component';
import { APP_VERSION } from '../../app.config';
import {
  MediaControlsService,
  type NowPlayingDiagnostics,
} from '../../services/media-controls.service';
import { isIosNative, isElectron } from '../../lib/platform';
import {
  pickDirectory,
  setMusicDir,
  revealLogs,
} from '../../services/native/native-capabilities';
import { ConfirmService } from '../../services/confirm.service';
import { UpdateService } from '../../services/update.service';
import { ToastService } from '../../services/toast.service';

const GB = 1024 * 1024 * 1024;

/** Selectable offline storage budgets (bytes). */
export const BUDGET_OPTIONS: { label: string; bytes: number }[] = [
  { label: '1 GB', bytes: 1 * GB },
  { label: '2 GB', bytes: 2 * GB },
  { label: '5 GB', bytes: 5 * GB },
  { label: '10 GB', bytes: 10 * GB },
  { label: 'Unlimited', bytes: UNLIMITED_BUDGET },
];

/** Selectable auto-preserve windows. 'full' is capped server-side at 200 tracks
 * to keep a runaway radio from filling tens of GB. */
export const AUTO_PRESERVE_OPTIONS: { value: AutoPreserveMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: '5', label: 'Next 5' },
  { value: '20', label: 'Next 20' },
  { value: 'full', label: 'Whole queue' },
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
  private confirm = inject(ConfirmService);
  readonly update = inject(UpdateService);
  private toast = inject(ToastService);

  /** The Now Playing diagnostics panel only exists in the native iOS shell. */
  readonly isNativeIos = isIosNative();
  readonly nowPlayingDiag = signal<NowPlayingDiagnostics | null>(null);
  readonly nowPlayingDiagLoading = signal(false);

  /** "Change music folder" only exists in the Electron desktop shell. */
  readonly isElectron = isElectron();
  readonly musicDirChanging = signal(false);
  /** Set once a folder is picked this session; the backend doesn't expose its current musicDir at runtime. */
  readonly musicDirChosen = signal<string | null>(null);
  /** Set when `setMusicDir` resolves `{ ok: false }` (e.g. the backend failed to boot against the new dir). */
  readonly musicDirError = signal<string | null>(null);

  readonly budgetOptions = BUDGET_OPTIONS;
  readonly autoPreserveOptions = AUTO_PRESERVE_OPTIONS;
  readonly themePresets = THEME_PRESETS;
  readonly myDeviceId = this.ws.getDeviceId();
  readonly version = inject(APP_VERSION);
  readonly showChangelog = signal(false);
  readonly showLogoutDialog = signal(false);
  readonly cleanPreserveOnLogout = signal(false);
  readonly updateToastId = signal<string | null>(null);

  readonly deviceName = signal(this.ws.getDeviceName());
  readonly deviceNameSaved = signal(false);

  isAdmin(): boolean {
    return this.auth.isAdmin();
  }

  async searchForUpdates(): Promise<void> {
    if (!this.update.checkAvailable()) return;
    try {
      const outcome = await this.update.checkForUpdate();
      if (outcome === 'unavailable') return;
      if (this.updateToastId()) this.toast.dismiss(this.updateToastId()!);
      const id = this.showUpdateToast(outcome);
      this.updateToastId.set(id);
    } catch {
      if (this.updateToastId()) this.toast.dismiss(this.updateToastId()!);
      const id = this.toast.show({
        message: "Couldn't check for updates — try again later.",
        kind: 'error',
        duration: 4,
      });
      this.updateToastId.set(id);
    }
  }

  reloadToUpdate(): void {
    if (this.updateToastId()) this.toast.dismiss(this.updateToastId()!);
    void this.update.applyUpdate();
  }

  private showUpdateToast(outcome: 'available' | 'up-to-date'): string {
    if (outcome === 'available') {
      const id = this.toast.show({
        message: 'A new version is downloading — reload when it\u2019s ready.',
        kind: 'info',
        duration: 8,
        actions: [
          { label: 'Reload', callback: () => this.reloadToUpdate() },
          { label: 'Later', callback: () => this.toast.dismiss(id) },
        ],
      });
      return id;
    }
    return this.toast.show({
      message: `You\u2019re on v${this.version}.`,
      kind: 'success',
      duration: 3,
    });
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

  /**
   * Auto-preserve toggle handler. Turning it OFF while auto-saved tracks
   * exist asks the user to confirm removal — otherwise it just flips the
   * mode without touching storage.
   */
  async onAutoPreserveClick(value: AutoPreserveMode): Promise<void> {
    if (value === 'off' && this.preserve.autoPreserveMode() !== 'off') {
      const count = this.preserve.autoPreservedCount();
      if (count > 0) {
        const ok = await this.confirm.ask(
          `Remove ${count} auto-saved track${count === 1 ? '' : 's'} from offline storage?`,
        );
        if (!ok) return;
        await this.preserve.removeAllAutoPreserved();
      }
    }
    this.preserve.setAutoPreserveMode(value);
  }

  /** One-line explainer for the current auto-preserve mode. */
  autoPreserveExplain(): string {
    switch (this.preserve.autoPreserveMode()) {
      case 'off':
        return 'Off — tracks play over the network. Locked-screen or flaky network may interrupt playback.';
      case '5':
        return 'Saves the current track + next 4 queued tracks (~40 MB).';
      case '20':
        return 'Saves the current track + next 19 queued tracks (~160 MB).';
      case 'full':
        return 'Saves the entire queue (up to 200 tracks).';
    }
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

  toggleAutoplayOnLoad(): void {
    this.auth.setAutoplayOnLoad(!this.auth.autoplayOnLoad());
  }

  saveDeviceName(): void {
    if (!this.deviceName().trim()) return;
    this.ws.setDeviceName(this.deviceName().trim());
    this.deviceNameSaved.set(true);
  }

  /**
   * Opens the native folder picker and, on a real pick, persists it
   * desktop-side and restarts the sidecar so the backend re-boots scanning
   * the new directory (it's already running against the old one, unlike the
   * onboarding pick which persists without restarting).
   */
  async changeMusicFolder(): Promise<void> {
    const path = await pickDirectory();
    if (!path) return;
    this.musicDirChanging.set(true);
    this.musicDirError.set(null);
    try {
      const result = await setMusicDir(path, { restart: true });
      if (result.ok) {
        this.musicDirChosen.set(path);
      } else {
        this.musicDirError.set(
          result.error ?? 'Failed to restart with the new music folder. The previous folder is still in use.',
        );
      }
    } finally {
      this.musicDirChanging.set(false);
    }
  }

  /** Opens the OS file manager at the active sidecar log. No-op outside
   *  Electron — the button is Electron-gated in the template. */
  async revealLogs(): Promise<void> {
    await revealLogs();
  }

  getDeviceEmoji(device: { type: string; name: string }): string {
    if (device.type !== 'web') return '🎵';
    return /iPhone|iPad|Android/i.test(device.name) ? '📱' : '🖥️';
  }
}
