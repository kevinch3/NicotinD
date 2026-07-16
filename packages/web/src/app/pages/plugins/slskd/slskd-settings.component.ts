import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SlskdStatus } from '@nicotind/core';
import { SystemApiService } from '../../../services/api/system-api.service';
import { PluginService } from '../../../services/plugin.service';
import { PasswordFieldComponent } from '../../../components/password-field/password-field.component';

/**
 * The slskd (Soulseek) extension's own settings surface — reachable from its
 * card on the Extensions page. Owns everything slskd-specific that used to be
 * hardcoded into the core Settings page: the connection form (account creds,
 * listening port, UPnP, connect/disconnect) and shared folders, plus a new
 * Nicotine+-style live status panel (current speeds, active/queued transfers,
 * configured limits, share size). All gated on the plugin being enabled — the
 * page shows an "enable it first" notice otherwise. Backend credential storage
 * is unchanged (still the admin-gated `/api/settings/soulseek*` routes); this
 * only relocates the UI so the extension owns its config.
 */
@Component({
  selector: 'app-slskd-settings',
  standalone: true,
  imports: [FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './slskd-settings.component.html',
})
export class SlskdSettingsComponent implements OnInit, OnDestroy {
  private api = inject(SystemApiService);
  readonly plugins = inject(PluginService);

  // Connection (moved from the old Settings "Soulseek Network" section)
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

  /**
   * False when the slskd service itself can't be reached (e.g. the desktop
   * app's external mode with no slskd running) — the connection + shares
   * forms are pointless then, so the template swaps them for a notice.
   * Permission errors (401/403) keep it true: slskd is up, the user isn't
   * an admin.
   */
  readonly slskdReachable = signal(true);

  // Shared folders (moved from the old Settings "Shared Folders" section)
  readonly shares = signal<string[]>([]);
  readonly newSharePath = signal('');
  readonly sharesLoading = signal(false);
  readonly sharesMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  // Live status panel
  readonly status = signal<SlskdStatus | null>(null);
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => this.pollStatus();

  ngOnInit(): void {
    void this.loadSettings();
    void this.loadShares();
    void this.pollStatus();
    // Refresh live speeds every 3s while the page is open + the tab is visible.
    this.statusTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.pollStatus();
    }, 3000);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  // --- Status ---
  private async pollStatus(): Promise<void> {
    if (!this.plugins.hasSlskd()) return;
    try {
      this.status.set(await firstValueFrom(this.plugins.getSlskdStatus()));
    } catch {
      /* transient — keep the last snapshot */
    }
  }

  /** Human-readable bytes/sec (e.g. "1.2 MB/s"). */
  formatSpeed(bytesPerSec: number): string {
    if (!bytesPerSec) return '0 KB/s';
    const kb = bytesPerSec / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB/s`;
    return `${(kb / 1024).toFixed(1)} MB/s`;
  }

  /** slskd speed limits are KiB/s; 0 = unlimited. */
  formatLimit(kib: number | undefined): string {
    if (kib == null) return '—';
    return kib === 0 ? 'Unlimited' : `${kib} KB/s`;
  }

  formatUptime(seconds: number | undefined): string {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // --- Connection (verbatim behavior from the old Settings component) ---
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

  private async loadSettings(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(this.api.getSoulseekSettings());
      this.username.set(data.username);
      this.listeningPort.set(data.listeningPort ?? 50000);
      this.enableUPnP.set(data.enableUPnP ?? true);
      this.configured.set(data.configured);
      this.connected.set(data.connected);
    } catch {
      /* ignore */
    } finally {
      this.loading.set(false);
    }
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

  // --- Shared folders (verbatim behavior from the old Settings component) ---
  private async loadShares(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getShares());
      this.shares.set(data.directories);
      this.slskdReachable.set(true);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 401 && status !== 403) this.slskdReachable.set(false);
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
}
