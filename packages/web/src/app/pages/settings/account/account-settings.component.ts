import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { PasswordFieldComponent } from '../../../components/password-field/password-field.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { AccountApiService } from '../../../services/api/account-api.service';
import { AuthService } from '../../../services/auth.service';
import { PageBackService } from '../../../services/page-back.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import { httpErrorCode, httpErrorMessageI18n } from '../../../lib/http-error';

/** Mirrors the API's `MIN_NEW_PASSWORD_LENGTH`. */
export const MIN_NEW_PASSWORD_LENGTH = 8;

/**
 * Settings → Account (docs/email-invitations.md, increment 2). Today: change
 * your own password, which also signs you out everywhere else. The email
 * address and its verification join this page in a later increment.
 */
@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [FormsModule, SettingsGroupComponent, PasswordFieldComponent, TranslatePipe],
  templateUrl: './account-settings.component.html',
})
export class AccountSettingsComponent {
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
