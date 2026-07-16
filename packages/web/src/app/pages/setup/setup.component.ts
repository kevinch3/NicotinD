import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { SystemApiService } from '../../services/api/system-api.service';
import type { SetupStatus, SetupBody } from '../../services/api/api-types';
import { SetupService } from '../../services/setup.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { isElectron } from '../../lib/platform';
import { pickDirectory, setMusicDir } from '../../services/native/native-capabilities';

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
  private router = inject(Router);

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

  /** Exposed for the template — Electron desktop shell shows a native folder picker. */
  readonly isElectron = isElectron;

  /**
   * Opens the OS directory dialog (Electron only) and fills musicDir on a
   * real pick. Also persists the pick desktop-side (no restart — the
   * backend hasn't finished onboarding yet and a mid-wizard restart would be
   * disruptive): the backend itself only holds `musicDir` in memory
   * (`packages/api/src/routes/setup.ts`), so without this the choice would
   * be lost on the very next app launch.
   */
  async chooseFolder(): Promise<void> {
    const path = await pickDirectory();
    if (path) {
      this.musicDir = path;
      await setMusicDir(path, { restart: false });
    }
  }

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

  /**
   * Leave the finished wizard and enter the app. `/setup` has no guard, so a bare
   * reload would just re-render the wizard; and the boot-time setup status is now
   * stale, so we mark it resolved to stop the root redirect bouncing us back here.
   */
  enterApp(): void {
    this.setupService.markComplete();
    this.router.navigate(['/']);
  }
}
