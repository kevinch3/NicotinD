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
  template: `
    <div class="max-w-2xl mx-auto px-4 py-5 md:px-6 md:py-8">
      <h1 class="text-xl font-bold text-theme-primary mb-8">Settings</h1>

      @if (loading()) {
        <p class="text-theme-muted">Loading settings...</p>
      } @else {
        <!-- Appearance -->
        <section class="rounded-xl border border-theme bg-theme-surface/50 p-6 mb-6">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-theme-secondary mb-5">Appearance</h2>

          <div class="flex items-start gap-3 mb-5">
            <button role="switch" [attr.aria-checked]="themeService.systemTheme()"
              (click)="themeService.setSystemTheme(!themeService.systemTheme())"
              [class]="'relative mt-0.5 w-9 h-5 rounded-full transition-colors flex-shrink-0 ' + (themeService.systemTheme() ? 'bg-emerald-600' : 'bg-theme-hover')">
              <span [class]="'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ' + (themeService.systemTheme() ? 'translate-x-4' : 'translate-x-0')"></span>
            </button>
            <div>
              <p class="text-sm text-theme-primary">Follow system theme</p>
              <p class="text-xs text-theme-muted mt-0.5">Automatically use light or dark based on your OS setting.</p>
            </div>
          </div>

          <div [class]="'grid grid-cols-3 gap-2 transition-opacity ' + (themeService.systemTheme() ? 'opacity-40 pointer-events-none' : '')">
            @for (preset of themePresets; track preset.id) {
              <button (click)="themeService.setTheme(preset.id)"
                [attr.data-theme]="preset.id"
                [class]="'rounded-lg overflow-hidden border-2 transition-all text-left ' + (themeService.theme() === preset.id ? 'border-indigo-500' : 'border-transparent hover:border-theme')"
                [attr.aria-label]="'Switch to ' + preset.name + ' theme'">
                <div class="h-10 flex flex-col gap-1 p-1.5" style="background: var(--theme-bg, #09090b)">
                  <div class="h-2 rounded-sm w-full" style="background: var(--theme-surface, #18181b)"></div>
                  <div class="h-1.5 rounded-sm w-3/4" style="background: var(--theme-surface-2, #27272a)"></div>
                </div>
                <div class="px-2 py-1.5 flex items-center justify-between" style="background: var(--theme-surface, #18181b)">
                  <span class="text-xs font-semibold" style="color: var(--theme-text-primary, #f4f4f5)">{{ preset.name }}</span>
                  @if (themeService.theme() === preset.id) {
                    <span class="text-indigo-400 text-xs">✓</span>
                  }
                </div>
              </button>
            }
          </div>
        </section>

        <!-- Soulseek Network -->
        <section class="rounded-xl border border-theme bg-theme-surface/50 p-6">
          <div class="flex items-center gap-3 mb-6">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-theme-secondary">Soulseek Network</h2>
            <div class="flex items-center gap-2">
              <span [class]="'inline-block w-2.5 h-2.5 rounded-full ' + statusDotClass()"></span>
              <span class="text-xs text-theme-muted">{{ statusLabel() }}</span>
            </div>
          </div>

          @if (isAdmin()) {
            <form (submit)="handleSave($event)" class="space-y-4">
              <div class="flex gap-1 p-1 rounded-lg bg-theme-surface-2/50 w-fit">
                <button type="button" (click)="isNewAccount.set(false); confirmPassword.set(''); message.set(null)"
                  [class]="'px-3 py-1.5 rounded-md text-xs font-medium transition ' + (!isNewAccount() ? 'bg-theme-hover text-theme-primary' : 'text-theme-secondary hover:text-theme-primary')">
                  I have an account
                </button>
                <button type="button" (click)="isNewAccount.set(true); message.set(null)"
                  [class]="'px-3 py-1.5 rounded-md text-xs font-medium transition ' + (isNewAccount() ? 'bg-theme-hover text-theme-primary' : 'text-theme-secondary hover:text-theme-primary')">
                  Create new account
                </button>
              </div>

              <div>
                <label class="block text-sm text-theme-secondary mb-1.5">Username</label>
                <input type="text" [ngModel]="username()" (ngModelChange)="username.set($event)" name="slskUser" placeholder="Soulseek username"
                  class="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm" />
              </div>
              <div>
                <label class="block text-sm text-theme-secondary mb-1.5">Password</label>
                <app-password-field [ngModel]="password()" (ngModelChange)="password.set($event)" name="slskPass"
                  [placeholder]="configured() && !isNewAccount() ? '••••••••' : 'Soulseek password'"
                  autocomplete="new-password"
                  inputClass="px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm" />
              </div>

              @if (isNewAccount()) {
                <div>
                  <label class="block text-sm text-theme-secondary mb-1.5">Confirm Password</label>
                  <app-password-field [ngModel]="confirmPassword()" (ngModelChange)="confirmPassword.set($event)" name="slskConfirm"
                    placeholder="Confirm password" autocomplete="new-password"
                    inputClass="px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm" />
                  @if (confirmPassword() && password() !== confirmPassword()) {
                    <p class="text-xs text-red-400 mt-1">Passwords do not match</p>
                  }
                </div>
              }

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-theme-secondary mb-1.5">Listening Port</label>
                  <input type="number" [ngModel]="listeningPort()" (ngModelChange)="listeningPort.set($event)" name="slskPort" placeholder="50000"
                    class="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm" />
                  <p class="text-xs text-theme-muted mt-1">Port for incoming P2P connections.</p>
                </div>
                <div class="flex flex-col justify-center">
                  <label class="flex items-center gap-2 cursor-pointer mt-2">
                    <input type="checkbox" [ngModel]="enableUPnP()" (ngModelChange)="enableUPnP.set($event)" name="slskUpnp"
                      class="w-4 h-4 rounded border-theme bg-theme-surface-2 text-theme-primary focus:ring-0 focus:ring-offset-0" />
                    <span class="text-sm text-theme-secondary">Enable UPnP</span>
                  </label>
                  <p class="text-xs text-theme-muted mt-1">Auto-forward port (requires router support).</p>
                </div>
              </div>

              @if (message()) {
                <div [class]="'px-4 py-2.5 rounded-lg text-sm ' + (message()!.type === 'success' ? 'bg-emerald-950/50 border border-emerald-900/50 text-emerald-400' : 'bg-red-950/50 border border-red-900/50 text-red-400')">
                  {{ message()!.text }}
                </div>
              }

              <button type="submit"
                [disabled]="saving() || !username().trim() || !password().trim() || (isNewAccount() && password() !== confirmPassword())"
                class="px-5 py-2.5 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
                {{ saving() ? (isNewAccount() ? 'Creating account...' : 'Saving...') : isNewAccount() ? 'Create Account & Connect' : configured() ? 'Update & Reconnect' : 'Save & Connect' }}
              </button>
            </form>
          } @else {
            <div class="text-sm text-theme-muted">
              <p>Only administrators can change Soulseek settings.</p>
              @if (configured() && username()) {
                <p class="mt-2 text-theme-secondary">Connected as: {{ username() }}</p>
              }
            </div>
          }
        </section>

        <!-- Tailscale -->
        @if (tsStatus()?.available) {
          <section class="rounded-xl border border-theme bg-theme-surface/50 p-6 mt-6">
            <div class="flex items-center gap-3 mb-6">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-theme-secondary">Tailscale Remote Access</h2>
              <div class="flex items-center gap-2">
                <span [class]="'inline-block w-2.5 h-2.5 rounded-full ' + (tsStatus()!.connected ? 'bg-emerald-500' : 'bg-theme-muted')"></span>
                <span class="text-xs text-theme-muted">{{ tsStatus()!.connected ? 'Connected' : 'Not connected' }}</span>
              </div>
            </div>

            @if (tsStatus()!.connected) {
              <div class="space-y-2 mb-4">
                @if (tsStatus()!.hostname) {
                  <div>
                    <span class="text-xs text-theme-muted">Hostname: </span>
                    <span class="text-sm text-theme-primary font-mono">{{ tsStatus()!.hostname }}</span>
                  </div>
                }
                @if (tsStatus()!.ip) {
                  <div>
                    <span class="text-xs text-theme-muted">IP: </span>
                    <span class="text-sm text-theme-secondary font-mono">{{ tsStatus()!.ip }}</span>
                  </div>
                }
              </div>
            }

            @if (isAdmin()) {
              @if (tsStatus()!.connected) {
                <button (click)="disconnectTailscale()" [disabled]="tsSaving()"
                  class="px-5 py-2.5 rounded-lg border border-theme text-theme-secondary text-sm font-medium hover:border-zinc-500 transition disabled:opacity-50">
                  {{ tsSaving() ? 'Disconnecting...' : 'Disconnect' }}
                </button>
              } @else {
                <div class="space-y-3">
                  <app-password-field [ngModel]="tsAuthKey()" (ngModelChange)="tsAuthKey.set($event)"
                    placeholder="tskey-auth-..." autocomplete="off"
                    inputClass="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm font-mono" />
                  <button (click)="connectTailscale()" [disabled]="tsSaving() || !tsAuthKey().trim()"
                    class="px-5 py-2.5 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
                    {{ tsSaving() ? 'Connecting...' : 'Connect' }}
                  </button>
                </div>
              }

              @if (tsMessage()) {
                <div [class]="'mt-3 px-4 py-2.5 rounded-lg text-sm ' + (tsMessage()!.type === 'success' ? 'bg-emerald-950/50 border border-emerald-900/50 text-emerald-400' : 'bg-red-950/50 border border-red-900/50 text-red-400')">
                  {{ tsMessage()!.text }}
                </div>
              }
            } @else if (!tsStatus()!.connected) {
              <p class="text-sm text-theme-muted">Only administrators can manage Tailscale connection.</p>
            }
          </section>
        }

        <!-- Remote Playback -->
        <section class="rounded-xl border border-theme bg-theme-surface/50 p-6 mt-6">
          <div class="flex items-center gap-3 mb-6">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-theme-secondary">Remote Playback</h2>
          </div>

          <div class="space-y-5">
            <div class="flex items-start gap-3">
              <button role="switch" [attr.aria-checked]="remote.remoteEnabled()"
                (click)="toggleRemote()"
                [class]="'relative mt-0.5 w-9 h-5 rounded-full transition-colors flex-shrink-0 ' + (remote.remoteEnabled() ? 'bg-emerald-600' : 'bg-theme-hover')">
                <span [class]="'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ' + (remote.remoteEnabled() ? 'translate-x-4' : 'translate-x-0')"></span>
              </button>
              <div>
                <p class="text-sm text-theme-primary">Make this device available as an audio output</p>
                <p class="text-xs text-theme-muted mt-0.5">When enabled, other devices on your account can cast audio to this device.</p>
                @if (!remote.remoteEnabled()) {
                  <p class="text-xs text-amber-500/80 mt-1">This device is hidden from the device selector on other devices.</p>
                }
              </div>
            </div>

            <div>
              <label class="block text-sm text-theme-secondary mb-1.5">This device's name</label>
              <div class="flex gap-2">
                <input type="text" [ngModel]="deviceName()" (ngModelChange)="deviceName.set($event); deviceNameSaved.set(false)"
                  placeholder="e.g. Living Room TV"
                  class="flex-1 px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm" />
                <button (click)="saveDeviceName()" [disabled]="!deviceName().trim() || deviceNameSaved()"
                  class="px-4 py-2.5 rounded-lg bg-theme-hover text-theme-primary text-sm font-medium hover:bg-theme-hover transition disabled:opacity-50">
                  {{ deviceNameSaved() ? 'Saved' : 'Save' }}
                </button>
              </div>
              <p class="text-xs text-theme-muted mt-1">Shown to other users when they switch playback devices.</p>
            </div>

            <div>
              <p class="text-sm text-theme-secondary mb-2">Connected devices</p>
              @if (remote.devices().length === 0) {
                <p class="text-sm text-theme-muted">No devices online</p>
              } @else {
                <ul class="space-y-1">
                  @for (device of remote.devices(); track device.id) {
                    <li class="flex items-center gap-2 text-sm">
                      <span>{{ getDeviceEmoji(device) }}</span>
                      <span [class]="device.id === myDeviceId ? 'text-theme-primary' : 'text-theme-secondary'">{{ device.name }}</span>
                      @if (device.id === myDeviceId) {
                        <span class="text-xs text-theme-muted">(this device)</span>
                      }
                      @if (device.id === remote.activeDeviceId()) {
                        <span class="ml-auto text-xs font-semibold tracking-wide px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-400">HOST</span>
                      }
                    </li>
                  }
                </ul>
              }
            </div>
          </div>
        </section>
      }
    </div>
  `,
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

  readonly deviceName = signal(this.ws.getDeviceName());
  readonly deviceNameSaved = signal(false);

  isAdmin(): boolean {
    return this.auth.role() === 'admin';
  }

  ngOnInit(): void {
    this.loadSettings();
    this.loadTailscaleStatus();
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
}
