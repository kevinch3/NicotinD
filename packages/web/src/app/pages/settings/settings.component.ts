import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type StreamingSettings } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ThemeService, THEME_PRESETS, type ThemeId } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService, UNLIMITED_BUDGET } from '../../services/preserve.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
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

type DuplicateSong = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  path: string;
  coverArt?: string;
};

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
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

  async refreshNowPlayingDiagnostics(): Promise<void> {
    this.nowPlayingDiagLoading.set(true);
    try {
      this.nowPlayingDiag.set(await this.mediaControls.getDiagnostics());
    } finally {
      this.nowPlayingDiagLoading.set(false);
    }
  }

  readonly budgetOptions = BUDGET_OPTIONS;
  readonly themePresets = THEME_PRESETS;
  readonly myDeviceId = this.ws.getDeviceId();
  readonly version = inject(APP_VERSION);

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

  readonly loading = signal(true);
  readonly username = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly listeningPort = signal(50000);
  readonly enableUPnP = signal(true);
  readonly isNewAccount = signal(false);
  readonly configured = signal(false);
  readonly connected = signal(false);
  readonly saving = signal(false);
  readonly message = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly toggling = signal(false);
  readonly toggleMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly shares = signal<string[]>([]);
  readonly newSharePath = signal('');
  readonly sharesLoading = signal(false);
  readonly sharesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly deviceName = signal(this.ws.getDeviceName());
  readonly deviceNameSaved = signal(false);

  // Maintenance — find duplicates
  readonly duplicatesLoading = signal(false);
  readonly duplicates = signal<DuplicateSong[][]>([]);
  readonly duplicatesDeleteSet = signal<Set<string>>(new Set());
  readonly duplicatesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly deletingDuplicates = signal(false);

  readonly streaming = signal<StreamingSettings | null>(null);
  readonly streamingSaving = signal(false);
  readonly streamingMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  isAdmin(): boolean {
    return this.auth.role() === 'admin';
  }

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }

  ngOnInit(): void {
    this.loadSettings();
    if (this.isAdmin()) {
      this.loadShares();
      this.loadStreaming();
    }
  }

  private async loadStreaming(): Promise<void> {
    try {
      this.streaming.set(await firstValueFrom(this.api.getStreamingSettings()));
    } catch {
      /* ignore */
    }
  }

  async saveStreaming(patch: Partial<StreamingSettings>): Promise<void> {
    this.streamingSaving.set(true);
    this.streamingMessage.set(null);
    try {
      this.streaming.set(await firstValueFrom(this.api.saveStreamingSettings(patch)));
      this.streamingMessage.set({ type: 'success', text: 'Streaming settings saved' });
    } catch {
      this.streamingMessage.set({ type: 'error', text: 'Failed to save streaming settings' });
    } finally {
      this.streamingSaving.set(false);
    }
  }

  statusDotClass(): string {
    if (!this.configured()) return 'bg-theme-muted';
    if (this.connected()) return 'bg-emerald-500';
    return 'bg-amber-500';
  }

  statusLabel(): string {
    if (!this.configured()) return 'Not configured';
    if (this.connected()) return 'Connected';
    return 'Disconnected';
  }

  async handleSave(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.username().trim() || !this.password().trim()) return;
    if (this.isNewAccount() && this.password() !== this.confirmPassword()) {
      this.message.set({ type: 'error', text: 'Passwords do not match' });
      return;
    }

    this.saving.set(true);
    this.message.set(null);

    try {
      const result = await firstValueFrom(
        this.api.saveSoulseekSettings(this.username().trim(), this.password().trim(), {
          listeningPort: this.listeningPort(),
          enableUPnP: this.enableUPnP(),
        }),
      );
      this.password.set('');
      this.confirmPassword.set('');

      if (result.connected) {
        this.configured.set(true);
        this.connected.set(true);
        this.message.set({
          type: 'success',
          text: this.isNewAccount()
            ? `Account created — connected as ${result.username ?? this.username().trim()}`
            : `Connected as ${result.username ?? this.username().trim()}`,
        });
      } else {
        this.configured.set(true);
        this.message.set({
          type: this.isNewAccount() ? 'error' : 'success',
          text: this.isNewAccount()
            ? 'Connection failed — username may already be taken'
            : 'Service started — connection may take a moment',
        });
        setTimeout(async () => {
          try {
            const status = await firstValueFrom(this.api.getSoulseekStatus());
            this.connected.set(status.connected);
            if (status.connected)
              this.message.set({ type: 'success', text: 'Connected to Soulseek network' });
          } catch {
            /* ignore */
          }
        }, 5000);
      }
    } catch (err) {
      this.message.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings',
      });
    } finally {
      this.saving.set(false);
    }
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

  private async loadSettings(): Promise<void> {
    this.loading.set(true);
    try {
      if (this.isAdmin()) {
        const data = await firstValueFrom(this.api.getSoulseekSettings());
        this.username.set(data.username);
        this.listeningPort.set(data.listeningPort ?? 50000);
        this.enableUPnP.set(data.enableUPnP ?? true);
        this.configured.set(data.configured);
        this.connected.set(data.connected);
      } else {
        const data = await firstValueFrom(this.api.getSoulseekStatus());
        this.configured.set(data.configured);
        this.connected.set(data.connected);
        this.username.set(data.username ?? '');
      }
    } catch {
      /* ignore */
    } finally {
      this.loading.set(false);
    }
  }

  async toggleConnection(): Promise<void> {
    this.toggling.set(true);
    this.toggleMessage.set(null);
    try {
      const result = await firstValueFrom(this.api.toggleSoulseekConnection());
      this.connected.set(result.connected);
      this.toggleMessage.set({
        type: 'success',
        text: result.connected
          ? 'Connected to Soulseek network'
          : 'Disconnected from Soulseek network',
      });
    } catch (err) {
      this.toggleMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Toggle failed',
      });
    } finally {
      this.toggling.set(false);
    }
  }

  private async loadShares(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getShares());
      this.shares.set(data.directories);
    } catch {
      /* ignore */
    }
  }

  async addShare(): Promise<void> {
    const path = this.newSharePath().trim();
    if (!path) return;
    this.sharesLoading.set(true);
    this.sharesMessage.set(null);
    try {
      await firstValueFrom(this.api.addShare(path));
      this.newSharePath.set('');
      await this.loadShares();
      this.sharesMessage.set({ type: 'success', text: `Added: ${path}` });
    } catch (err) {
      this.sharesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to add directory',
      });
    } finally {
      this.sharesLoading.set(false);
    }
  }

  async removeShare(path: string): Promise<void> {
    this.sharesLoading.set(true);
    this.sharesMessage.set(null);
    try {
      await firstValueFrom(this.api.removeShare(path));
      await this.loadShares();
    } catch (err) {
      this.sharesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to remove directory',
      });
    } finally {
      this.sharesLoading.set(false);
    }
  }

  async rescanShares(): Promise<void> {
    this.sharesLoading.set(true);
    this.sharesMessage.set(null);
    try {
      await firstValueFrom(this.api.rescanShares());
      this.sharesMessage.set({ type: 'success', text: 'Rescan triggered' });
    } catch (err) {
      this.sharesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Rescan failed',
      });
    } finally {
      this.sharesLoading.set(false);
    }
  }

  async loadDuplicates(): Promise<void> {
    this.duplicatesLoading.set(true);
    this.duplicatesMessage.set(null);
    this.duplicates.set([]);
    this.duplicatesDeleteSet.set(new Set());
    try {
      const groups = await firstValueFrom(this.api.getDuplicates());
      this.duplicates.set(groups);
      if (groups.length === 0) {
        this.duplicatesMessage.set({ type: 'success', text: 'No duplicates found' });
      } else {
        // Auto-select lower-quality copies for deletion (all but the first in each group, which is sorted best-first)
        const toDelete = new Set<string>();
        for (const group of groups) {
          for (const song of group.slice(1)) {
            toDelete.add(song.id);
          }
        }
        this.duplicatesDeleteSet.set(toDelete);
      }
    } catch (err) {
      this.duplicatesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to load duplicates',
      });
    } finally {
      this.duplicatesLoading.set(false);
    }
  }

  toggleDuplicateDelete(id: string): void {
    const current = new Set(this.duplicatesDeleteSet());
    if (current.has(id)) current.delete(id);
    else current.add(id);
    this.duplicatesDeleteSet.set(current);
  }

  isDuplicateMarked(id: string): boolean {
    return this.duplicatesDeleteSet().has(id);
  }

  async deleteMarkedDuplicates(): Promise<void> {
    const ids = [...this.duplicatesDeleteSet()];
    if (ids.length === 0) return;
    this.deletingDuplicates.set(true);
    this.duplicatesMessage.set(null);
    try {
      const result = await firstValueFrom(this.api.deleteSongs(ids));
      this.duplicatesMessage.set({
        type: 'success',
        text: `Deleted ${result.deletedCount} file${result.deletedCount !== 1 ? 's' : ''}`,
      });
      await this.loadDuplicates();
    } catch (err) {
      this.duplicatesMessage.set({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete',
      });
    } finally {
      this.deletingDuplicates.set(false);
    }
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
