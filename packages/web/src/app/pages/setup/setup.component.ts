import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { ApiService, type SetupStatus } from '../../services/api.service';
import { SetupService } from '../../services/setup.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';

type Step = 'admin' | 'soulseek' | 'tailscale' | 'done';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, PasswordFieldComponent],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-zinc-950">
      <div class="w-full max-w-md px-6">
        <h1 class="text-3xl font-bold text-center mb-2 text-zinc-100">NicotinD</h1>
        <p class="text-zinc-500 text-center text-sm mb-8">Initial Setup</p>

        @if (step() !== 'done') {
          <div class="flex items-center gap-2 mb-6 justify-center">
            @for (i of stepDots(); track i) {
              <div class="h-1 rounded-full transition-all w-8"
                [class]="i <= stepNumber() ? 'bg-zinc-100' : 'bg-zinc-800'"
              ></div>
            }
          </div>
        }

        <!-- Step 1: Admin -->
        @if (step() === 'admin') {
          <form (ngSubmit)="handleAdminNext()" class="space-y-4">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-4">Create Admin Account</h2>
              <div class="space-y-3">
                <input type="text" placeholder="Username" [(ngModel)]="adminUsername" name="adminUser" required autofocus
                  class="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm" />
                <app-password-field [(ngModel)]="adminPassword" name="adminPass" [placeholder]="'Password'" [required]="true" [autocomplete]="'new-password'"
                  [inputClass]="'px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm'" />
              </div>
            </div>
            @if (error()) { <p class="text-red-400 text-sm">{{ error() }}</p> }
            <button type="submit" [disabled]="!adminUsername.trim() || !adminPassword.trim()"
              class="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
              Next
            </button>
          </form>
        }

        <!-- Step 2: Soulseek -->
        @if (step() === 'soulseek') {
          <div class="space-y-4">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-1">Soulseek Network</h2>
              <p class="text-xs text-zinc-600 mb-4">Connect to Soulseek for P2P music search. You can skip this and configure it later in Settings.</p>
              <div class="flex gap-1 p-1 rounded-lg bg-zinc-800/50 w-fit mb-4">
                <button type="button" (click)="slskIsNewAccount.set(false); slskConfirmPassword = ''; error.set('')"
                  [class]="!slskIsNewAccount() ? 'px-3 py-1.5 rounded-md text-xs font-medium transition bg-zinc-700 text-zinc-100' : 'px-3 py-1.5 rounded-md text-xs font-medium transition text-zinc-400 hover:text-zinc-200'">
                  I have an account
                </button>
                <button type="button" (click)="slskIsNewAccount.set(true); error.set('')"
                  [class]="slskIsNewAccount() ? 'px-3 py-1.5 rounded-md text-xs font-medium transition bg-zinc-700 text-zinc-100' : 'px-3 py-1.5 rounded-md text-xs font-medium transition text-zinc-400 hover:text-zinc-200'">
                  Create new account
                </button>
              </div>
              <div class="space-y-3">
                <input type="text" [placeholder]="slskIsNewAccount() ? 'Choose a username' : 'Soulseek username'" [(ngModel)]="slskUsername" name="slskUser" autofocus
                  class="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm" />
                <app-password-field [(ngModel)]="slskPassword" name="slskPass" [placeholder]="slskIsNewAccount() ? 'Choose a password' : 'Soulseek password'" [autocomplete]="'new-password'"
                  [inputClass]="'px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm'" />
                @if (slskIsNewAccount()) {
                  <app-password-field [(ngModel)]="slskConfirmPassword" name="slskConfirm" [placeholder]="'Confirm password'" [autocomplete]="'new-password'"
                    [inputClass]="'px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm'" />
                  @if (slskConfirmPassword && slskPassword !== slskConfirmPassword) {
                    <p class="text-xs text-red-400">Passwords do not match</p>
                  }
                }
              </div>
            </div>
            @if (error()) { <p class="text-red-400 text-sm">{{ error() }}</p> }
            <div class="flex gap-3">
              <button (click)="step.set('admin')" class="px-5 py-3 rounded-lg border border-zinc-800 text-zinc-400 text-sm font-medium hover:border-zinc-600 transition">Back</button>
              <button (click)="handleSoulseekNext()" [disabled]="loading()"
                class="flex-1 py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
                {{ soulseekButtonLabel() }}
              </button>
            </div>
          </div>
        }

        <!-- Step 3: Tailscale -->
        @if (step() === 'tailscale') {
          <div class="space-y-4">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-1">Tailscale Remote Access</h2>
              <p class="text-xs text-zinc-600 mb-4">Connect to your Tailscale network for secure remote access. You can skip this and configure it later.</p>
              <app-password-field [(ngModel)]="tsAuthKey" [placeholder]="'tskey-auth-...'" [autocomplete]="'off'" autofocus
                [inputClass]="'px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm font-mono'" />
            </div>
            @if (error()) { <p class="text-red-400 text-sm">{{ error() }}</p> }
            <div class="flex gap-3">
              <button (click)="step.set('soulseek')" class="px-5 py-3 rounded-lg border border-zinc-800 text-zinc-400 text-sm font-medium hover:border-zinc-600 transition">Back</button>
              <button (click)="handleTailscaleNext()" [disabled]="loading()"
                class="flex-1 py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
                {{ loading() ? 'Setting up...' : tsAuthKey.trim() ? 'Connect & Complete' : 'Skip & Complete' }}
              </button>
            </div>
          </div>
        }

        <!-- Done -->
        @if (step() === 'done') {
          <div class="space-y-4">
            <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
              <div class="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 class="text-lg font-semibold text-zinc-100 mb-1">Setup Complete</h2>
              <p class="text-sm text-zinc-500">Your NicotinD instance is ready.</p>
              @if (tsHostname()) {
                <div class="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                  <p class="text-xs text-zinc-500 mb-1">Tailscale Address</p>
                  <p class="text-sm text-zinc-200 font-mono">{{ tsHostname() }}</p>
                  @if (tsIp()) { <p class="text-xs text-zinc-500 mt-0.5">{{ tsIp() }}</p> }
                </div>
              }
            </div>
            <button (click)="reload()" class="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition">Get Started</button>
          </div>
        }
      </div>
    </div>
  `,
})
export class SetupComponent {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private setupService = inject(SetupService);

  readonly step = signal<Step>('admin');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly slskIsNewAccount = signal(false);
  readonly tsHostname = signal('');
  readonly tsIp = signal('');

  adminUsername = '';
  adminPassword = '';
  slskUsername = '';
  slskPassword = '';
  slskConfirmPassword = '';
  tsAuthKey = '';

  private adminData: { username: string; password: string } | null = null;
  private slskData: { username: string; password: string } | null = null;

  get setupStatus(): SetupStatus | null {
    return this.setupService.status();
  }

  stepNumber(): number {
    const s = this.step();
    if (s === 'admin') return 1;
    if (s === 'soulseek') return 2;
    if (s === 'tailscale') return 3;
    return 4;
  }

  stepDots(): number[] {
    const total = this.setupStatus?.tailscale.available ? 3 : 2;
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  soulseekButtonLabel(): string {
    const hasSlsk = this.slskUsername.trim() && this.slskPassword.trim();
    const hasTailscale = this.setupStatus?.tailscale.available;
    if (hasSlsk) return hasTailscale ? 'Next' : 'Complete Setup';
    return hasTailscale ? 'Skip' : 'Skip & Complete';
  }

  handleAdminNext(): void {
    if (!this.adminUsername.trim() || !this.adminPassword.trim()) return;
    this.adminData = { username: this.adminUsername.trim(), password: this.adminPassword.trim() };
    this.error.set('');
    this.step.set('soulseek');
  }

  handleSoulseekNext(): void {
    if (this.slskIsNewAccount() && this.slskPassword !== this.slskConfirmPassword) {
      this.error.set('Passwords do not match');
      return;
    }
    if (this.slskUsername.trim() && this.slskPassword.trim()) {
      this.slskData = { username: this.slskUsername.trim(), password: this.slskPassword.trim() };
    }
    this.error.set('');
    if (this.setupStatus?.tailscale.available) {
      this.step.set('tailscale');
    } else {
      this.submitSetup(this.slskData, null);
    }
  }

  handleTailscaleNext(): void {
    this.submitSetup(this.slskData, this.tsAuthKey.trim() || null);
  }

  private submitSetup(
    soulseek: { username: string; password: string } | null,
    tailscaleKey: string | null,
  ): void {
    if (!this.adminData) return;
    this.loading.set(true);
    this.error.set('');

    this.api.completeSetup({
      admin: this.adminData,
      ...(soulseek ? { soulseek } : {}),
      ...(tailscaleKey ? { tailscale: { authKey: tailscaleKey } } : {}),
    }).subscribe({
      next: (result) => {
        if (result.tailscale.connected && result.tailscale.hostname) {
          this.tsHostname.set(result.tailscale.hostname);
          this.tsIp.set(result.tailscale.ip ?? '');
        }
        this.auth.login(result.token, result.user.username, result.user.role);
        this.step.set('done');
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.error ?? err.message ?? 'Setup failed');
        this.loading.set(false);
      },
    });
  }

  reload(): void {
    window.location.reload();
  }
}
