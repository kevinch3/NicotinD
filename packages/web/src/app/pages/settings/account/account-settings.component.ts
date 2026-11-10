import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { PasswordFieldComponent } from '../../../components/password-field/password-field.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import {
  AccountApiService,
  type AccountEmailResult,
  type AccountView,
} from '../../../services/api/account-api.service';
import { mailReasonKey } from '../../admin/email-delivery/email-delivery-panel.component';
import { AuthService } from '../../../services/auth.service';
import { PageBackService } from '../../../services/page-back.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import { httpErrorCode, httpErrorMessageI18n } from '../../../lib/http-error';

/** Mirrors the API's `MIN_NEW_PASSWORD_LENGTH`. */
export const MIN_NEW_PASSWORD_LENGTH = 8;

/** What the Email group's status line says: the four states an address can be in. */
export type AccountEmailStatus = 'verified' | 'unverified' | 'pending' | 'none';

export function accountEmailStatus(view: AccountView | null): AccountEmailStatus {
  if (!view) return 'none';
  if (view.pendingEmail) return 'pending';
  if (view.email) return view.emailVerified ? 'verified' : 'unverified';
  return 'none';
}

/** The line under the Email form after a save. */
export interface EmailSaveOutcome {
  kind: 'sent' | 'failed' | 'cleared' | 'unchanged';
  email?: string;
  reasonKey?: string;
}

/**
 * Settings → Account (docs/email-invitations.md, increments 2 and 5): your
 * email address — added or changed through a verification link, so only a
 * proven address is ever used for password resets — and changing your own
 * password, which also signs you out everywhere else.
 *
 * Both writes ask for the current password. The Email group is read-only with
 * an explanation while the server cannot send mail: a change needs a link.
 */
@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [FormsModule, SettingsGroupComponent, PasswordFieldComponent, TranslatePipe],
  templateUrl: './account-settings.component.html',
})
export class AccountSettingsComponent implements OnInit {
  constructor() {
    inject(PageBackService).registerRoute(['/settings']);
  }

  private readonly api = inject(AccountApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly i18n = inject(TranslateService);

  readonly minPassword = MIN_NEW_PASSWORD_LENGTH;
  readonly currentPassword = signal('');
  readonly newPassword = signal('');
  readonly confirmPassword = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  // ── Email (increment 5) ────────────────────────────────────────────────
  readonly account = signal<AccountView | null>(null);
  readonly emailInput = signal('');
  readonly emailPassword = signal('');
  readonly emailSaving = signal(false);
  readonly emailError = signal<string | null>(null);
  readonly emailOutcome = signal<EmailSaveOutcome | null>(null);

  readonly emailStatus = computed(() => accountEmailStatus(this.account()));
  readonly mailEnabled = computed(() => this.account()?.mailEnabled === true);
  readonly canSaveEmail = computed(
    () => !this.emailSaving() && this.mailEnabled() && this.emailPassword().length > 0,
  );

  ngOnInit(): void {
    void this.loadAccount();
  }

  private async loadAccount(): Promise<void> {
    try {
      this.applyAccount(await firstValueFrom(this.api.getAccount()));
    } catch (err) {
      this.emailError.set(
        httpErrorMessageI18n(err, this.i18n, this.i18n.t('account.emailLoadFailed')),
      );
    }
  }

  private applyAccount(view: AccountView): void {
    this.account.set(view);
    this.emailInput.set(view.pendingEmail ?? view.email ?? '');
  }

  /** Empty clears the address; anything else mails a link to it. */
  async saveEmail(): Promise<void> {
    if (!this.canSaveEmail()) return;
    const email = this.emailInput().trim();
    this.emailSaving.set(true);
    this.emailError.set(null);
    this.emailOutcome.set(null);
    try {
      const res: AccountEmailResult = await firstValueFrom(
        this.api.changeEmail(email, this.emailPassword()),
      );
      this.applyAccount(res);
      this.emailPassword.set('');
      this.emailOutcome.set(
        !email
          ? { kind: 'cleared' }
          : !res.mail
            ? { kind: 'unchanged', email }
            : res.mail.ok
              ? { kind: 'sent', email: res.pendingEmail ?? email }
              : { kind: 'failed', email, reasonKey: mailReasonKey(res.mail.reason) },
      );
    } catch (err) {
      const code = httpErrorCode(err);
      this.emailError.set(
        code === 'INVALID_CREDENTIALS'
          ? this.i18n.t('account.currentPasswordWrong')
          : code === 'EMAIL_TAKEN'
            ? this.i18n.t('account.emailTaken')
            : httpErrorMessageI18n(err, this.i18n, this.i18n.t('account.emailSaveFailed')),
      );
    } finally {
      this.emailSaving.set(false);
    }
  }

  readonly mismatch = computed(
    () => this.confirmPassword().length > 0 && this.newPassword() !== this.confirmPassword(),
  );
  readonly canSave = computed(
    () =>
      !this.saving() &&
      this.currentPassword().length > 0 &&
      this.newPassword().length >= MIN_NEW_PASSWORD_LENGTH &&
      this.newPassword() === this.confirmPassword(),
  );

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(
        this.api.changePassword(this.currentPassword(), this.newPassword()),
      );
      // The old token died with the bump; this device carries on with the new one.
      this.auth.setToken(res.token);
      this.currentPassword.set('');
      this.newPassword.set('');
      this.confirmPassword.set('');
      this.toast.show({ message: this.i18n.t('account.passwordChanged'), kind: 'success' });
    } catch (err) {
      this.error.set(
        httpErrorCode(err) === 'INVALID_CREDENTIALS'
          ? this.i18n.t('account.currentPasswordWrong')
          : httpErrorMessageI18n(err, this.i18n, this.i18n.t('account.passwordChangeFailed')),
      );
    } finally {
      this.saving.set(false);
    }
  }
}
