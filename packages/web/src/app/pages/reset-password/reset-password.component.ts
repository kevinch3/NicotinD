import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { AccountApiService } from '../../services/api/account-api.service';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '../../services/translate.service';
import { httpErrorCode, httpErrorMessageI18n } from '../../lib/http-error';
import { parseInviteToken } from '../../lib/invite-link';

/** Mirrors the API's `MIN_NEW_PASSWORD_LENGTH`. */
export const MIN_RESET_PASSWORD_LENGTH = 8;

export type ResetPageState = 'loading' | 'form' | 'invalid' | 'expired' | 'used' | 'done';

const TERMINAL_CODES: Record<string, ResetPageState> = {
  RESET_INVALID: 'invalid',
  RESET_EXPIRED: 'expired',
  RESET_USED: 'used',
};

/**
 * `/reset-password#t=<token>` (docs/email-invitations.md, increment 2): where
 * a reset link lands. Public, like `/invite` — the person cannot sign in, which
 * is the whole point — and the token rides in the fragment. Setting the new
 * password ends every other session and signs this browser in.
 */
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, PasswordFieldComponent],
  templateUrl: './reset-password.component.html',
})
export class ResetPasswordComponent implements OnInit {
  private readonly api = inject(AccountApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly i18n = inject(TranslateService);

  readonly state = signal<ResetPageState>('loading');
  readonly username = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);
  readonly minPassword = MIN_RESET_PASSWORD_LENGTH;
  private token: string | null = null;

  readonly mismatch = computed(
    () => this.confirmPassword().length > 0 && this.password() !== this.confirmPassword(),
  );
  readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      this.password().length >= MIN_RESET_PASSWORD_LENGTH &&
      this.password() === this.confirmPassword(),
  );

  ngOnInit(): void {
    this.token = parseInviteToken(window.location.hash, window.location.search);
    void this.inspect();
  }

  private async inspect(): Promise<void> {
    if (!this.token) {
      this.state.set('invalid');
      return;
    }
    try {
      const res = await firstValueFrom(this.api.inspectReset(this.token));
      if (res.status === 'valid') {
        this.username.set(res.username);
        this.state.set('form');
      } else {
        this.state.set(res.status);
      }
    } catch {
      this.state.set('invalid');
    }
  }

  async submit(): Promise<void> {
    if (!this.token || !this.canSubmit()) return;
    this.submitting.set(true);
    this.formError.set(null);
    try {
      const res = await firstValueFrom(this.api.completeReset(this.token, this.password()));
      this.auth.login(res.token, res.user.username, res.user.role);
      this.state.set('done');
      await this.router.navigateByUrl('/');
    } catch (err) {
      const terminal = TERMINAL_CODES[httpErrorCode(err) ?? ''];
      if (terminal) this.state.set(terminal);
      else
        this.formError.set(
          httpErrorMessageI18n(err, this.i18n, this.i18n.t('resetPassword.failed')),
        );
    } finally {
      this.submitting.set(false);
    }
  }
}
