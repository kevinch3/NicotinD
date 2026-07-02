import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { SystemApiService } from '../../services/api/system-api.service';
import type { SetupStatus, SetupBody } from '../../services/api/api-types';
import { SetupService } from '../../services/setup.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';

type Step = 'admin' | 'library' | 'quality' | 'soulseek' | 'done';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, PasswordFieldComponent],
  templateUrl: './setup.component.html',
})
export class SetupComponent {
  private auth = inject(AuthService);
  private api = inject(SystemApiService);
  private setupService = inject(SetupService);

  readonly step = signal<Step>('admin');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly slskIsNewAccount = signal(false);
  readonly showLidarr = signal(false);
  readonly needsRestart = signal(false);

  adminUsername = '';
  adminPassword = '';
  musicDir = '';
  transcodeLosslessEnabled = true;
  transcodeBitrate = 192;
  slskUsername = '';
  slskPassword = '';
  slskConfirmPassword = '';
  lidarrUrl = '';
  lidarrApiKey = '';

  private adminData: { username: string; password: string } | null = null;
  private slskData: { username: string; password: string } | null = null;

  private get musicDirDefault(): string {
    return this.musicDir || '~/Music';
  }

  get setupStatus(): SetupStatus | null {
    return this.setupService.status();
  }

  stepNumber(): number {
    const s = this.step();
    if (s === 'admin') return 1;
    if (s === 'library') return 2;
    if (s === 'quality') return 3;
    if (s === 'soulseek') return 4;
    return 5;
  }

  stepDots(): number[] {
    return Array.from({ length: 4 }, (_, i) => i + 1);
  }

  soulseekButtonLabel(): string {
    const hasSlsk = this.slskUsername.trim() && this.slskPassword.trim();
    return hasSlsk ? 'Complete Setup' : 'Skip & Complete';
  }

  handleAdminNext(): void {
    if (!this.adminUsername.trim() || !this.adminPassword.trim()) return;
    this.adminData = { username: this.adminUsername.trim(), password: this.adminPassword.trim() };
    this.error.set('');
    this.step.set('library');
  }

  handleLibraryNext(): void {
    this.error.set('');
    this.step.set('quality');
  }

  handleQualityNext(): void {
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
    this.submitSetup(this.slskData);
  }

  private submitSetup(
    soulseek: { username: string; password: string } | null,
  ): void {
    if (!this.adminData) return;
    this.loading.set(true);
    this.error.set('');

    const body: SetupBody = {
      admin: this.adminData,
      ...(soulseek ? { soulseek } : {}),
      ...(this.musicDir.trim() ? { musicDir: this.musicDir.trim() } : {}),
      transcodeLossless: {
        enabled: this.transcodeLosslessEnabled,
        bitRate: this.transcodeBitrate,
      },
      ...(this.showLidarr() && (this.lidarrUrl.trim() || this.lidarrApiKey.trim())
        ? {
            lidarr: {
              ...(this.lidarrUrl.trim() ? { url: this.lidarrUrl.trim() } : {}),
              ...(this.lidarrApiKey.trim() ? { apiKey: this.lidarrApiKey.trim() } : {}),
            },
          }
        : {}),
    };

    this.api.completeSetup(body).subscribe({
      next: (result) => {
        this.auth.login(result.token, result.user.username, result.user.role);
        this.needsRestart.set(result.needsRestart ?? false);
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
