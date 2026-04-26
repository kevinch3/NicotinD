import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, type TailscaleStatus } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ThemeService, THEME_PRESETS, type ThemeId } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, PasswordFieldComponent],
  templateUrl: './settings.component.html',
  })
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  readonly themeService = inject(ThemeService);
  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);

  readonly themePresets = THEME_PRESETS;
  readonly myDeviceId = this.ws.getDeviceId();

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

  readonly tsStatus = signal<TailscaleStatus | null>(null);
  readonly tsAuthKey = signal('');
  readonly tsSaving = signal(false);
  readonly tsMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly toggling = signal(false);
  readonly toggleMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly shares = signal<string[]>([]);
  readonly newSharePath = signal('');
  readonly sharesLoading = signal(false);
  readonly sharesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  readonly deviceName = signal(this.ws.getDeviceName());
  readonly deviceNameSaved = signal(false);

  isAdmin(): boolean {
    return this.auth.role() === 'admin';
  }

  ngOnInit(): void {
    this.loadSettings();
    this.loadTailscaleStatus();
    if (this.isAdmin()) this.loadShares();
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
      const result = await firstValueFrom(this.api.saveSoulseekSettings(
        this.username().trim(),
        this.password().trim(),
        { listeningPort: this.listeningPort(), enableUPnP: this.enableUPnP() },
      ));
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
            if (status.connected) this.message.set({ type: 'success', text: 'Connected to Soulseek network' });
          } catch { /* ignore */ }
        }, 5000);
      }
    } catch (err) {
      this.message.set({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save settings' });
    } finally {
      this.saving.set(false);
    }
  }

  async toggleRemote(): Promise<void> {
    const enabled = !this.remote.remoteEnabled();
    if (enabled) {
      const audio = document.querySelector('audio');
      if (audio && audio.paused) {
        try { await audio.play(); audio.pause(); } catch { /* ignore */ }
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

  async connectTailscale(): Promise<void> {
    if (!this.tsAuthKey().trim()) return;
    this.tsSaving.set(true);
    this.tsMessage.set(null);
    try {
      const status = await firstValueFrom(this.api.connectTailscale(this.tsAuthKey().trim()));
      this.tsStatus.set(status);
      this.tsAuthKey.set('');
      this.tsMessage.set({ type: 'success', text: `Connected as ${status.hostname ?? 'nicotind'}` });
    } catch (err) {
      this.tsMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Failed to connect' });
    } finally {
      this.tsSaving.set(false);
    }
  }

  async disconnectTailscale(): Promise<void> {
    this.tsSaving.set(true);
    this.tsMessage.set(null);
    try {
      await firstValueFrom(this.api.disconnectTailscale());
      this.tsStatus.update(s => s ? { ...s, connected: false, hostname: undefined, ip: undefined } : s);
      this.tsMessage.set({ type: 'success', text: 'Disconnected from Tailscale' });
    } catch (err) {
      this.tsMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Failed to disconnect' });
    } finally {
      this.tsSaving.set(false);
    }
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
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }

  private async loadTailscaleStatus(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.getTailscaleStatus());
      this.tsStatus.set(status);
    } catch { /* ignore */ }
  }

  async toggleConnection(): Promise<void> {
    this.toggling.set(true);
    this.toggleMessage.set(null);
    try {
      const result = await firstValueFrom(this.api.toggleSoulseekConnection());
      this.connected.set(result.connected);
      this.toggleMessage.set({
        type: 'success',
        text: result.connected ? 'Connected to Soulseek network' : 'Disconnected from Soulseek network',
      });
    } catch (err) {
      this.toggleMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Toggle failed' });
    } finally {
      this.toggling.set(false);
    }
  }

  private async loadShares(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getShares());
      this.shares.set(data.directories);
    } catch { /* ignore */ }
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
      this.sharesMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Failed to add directory' });
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
      this.sharesMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Failed to remove directory' });
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
      this.sharesMessage.set({ type: 'error', text: err instanceof Error ? err.message : 'Rescan failed' });
    } finally {
      this.sharesLoading.set(false);
    }
  }
}
