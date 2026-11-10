import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { AuthService } from '../../services/auth.service';
import { InvitesApiService } from '../../services/api/invites-api.service';
import type { InviteInspection } from '../../services/api/api-types';
import { TranslateService } from '../../services/translate.service';
import { httpErrorCode, httpErrorMessageI18n } from '../../lib/http-error';
import { parseInviteToken } from '../../lib/invite-link';

/** Mirrors the API's `MIN_INVITE_PASSWORD_LENGTH`. */
export const MIN_INVITE_PASSWORD_LENGTH = 8;

/**
 * Every state the page can be in. `form` is the only one with inputs; the
 * finished-invite states each get their own copy, because "ask for a new one"
 * is the right advice for expired but not for revoked.
 */
export type InvitePageState =
  'loading' | 'form' | 'signed-in' | 'invalid' | 'expired' | 'used' | 'revoked' | 'done';

/** Accept-time error codes that end the invite rather than the attempt. */
const TERMINAL_CODES: Record<string, InvitePageState> = {
  INVITE_INVALID: 'invalid',
  INVITE_EXPIRED: 'expired',
  INVITE_USED: 'used',
  INVITE_REVOKED: 'revoked',
};

/**
 * `/invite#t=<token>` — where an invite link lands (docs/email-invitations.md).
 * Public and unguarded, like `/pair`: the token is the credential, it rides in
 * the fragment so no log sees it, and the page reads it then talks to the
 * server it was served by. The invitee picks a username and password; the role
 * was decided by the admin who minted the link.
 */
@Component({
  selector: 'app-invite-accept',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, PasswordFieldComponent],
  templateUrl: './invite-accept.component.html',
})
export class InviteAcceptComponent implements OnInit {
  private readonly api = inject(InvitesApiService);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(TranslateService);

  readonly state = signal<InvitePageState>('loading');
  readonly inspection = signal<InviteInspection | null>(null);
  readonly username = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);

  readonly minPassword = MIN_INVITE_PASSWORD_LENGTH;
  private token: string | null = null;

  readonly invitedBy = computed(() => {
    const i = this.inspection();
    return i && 'invitedBy' in i ? i.invitedBy : null;
  });
  readonly role = computed(() => {
    const i = this.inspection();
    return i?.status === 'pending' ? i.role : null;
  });
  readonly serverName = computed(() => this.inspection()?.serverName ?? '');

  readonly passwordsMismatch = computed(
    () => this.confirmPassword().length > 0 && this.password() !== this.confirmPassword(),
  );
  readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      this.username().trim().length > 0 &&
      !/\s/.test(this.username().trim()) &&
      this.password().length >= MIN_INVITE_PASSWORD_LENGTH &&
      this.password() === this.confirmPassword(),
  );

  /**
   * Methods, not computeds: they read the active catalog through `t()`, which
   * a language switch changes without touching any signal these depend on.
   */
  summary(): string {
    const role = this.i18n.t('admin.role.' + (this.role() ?? 'user'));
    const admin = this.invitedBy();
    return admin
      ? this.i18n.t('invite.summaryBy', { admin, server: this.serverName(), role })
      : this.i18n.t('invite.summary', { server: this.serverName(), role });
  }

  stateMessage(): string {
    const admin = this.invitedBy() ?? this.i18n.t('invite.yourAdmin');
    return this.i18n.t('invite.state.' + this.state(), { admin });
  }

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
      const res = await firstValueFrom(this.api.inspect(this.token));
      this.inspection.set(res);
      if (res.status !== 'pending') {
        this.state.set(res.status);
        return;
      }
      // Accepting while signed in would leave this browser on the wrong
      // account, so the page says so instead of silently swapping sessions.
      this.state.set(this.auth.isAuthenticated() ? 'signed-in' : 'form');
    } catch {
      this.state.set('invalid');
    }
  }

  signOutAndContinue(): void {
    this.auth.logout();
    this.state.set('form');
  }

  async submit(): Promise<void> {
    if (!this.token || !this.canSubmit()) return;
    this.submitting.set(true);
    this.formError.set(null);
    try {
      const res = await firstValueFrom(
        this.api.accept(this.token, this.username().trim(), this.password()),
      );
      this.auth.login(res.token, res.user.username, res.user.role);
      this.state.set('done');
      await this.router.navigateByUrl('/');
    } catch (err) {
      const terminal = TERMINAL_CODES[httpErrorCode(err) ?? ''];
      if (terminal) {
        this.state.set(terminal);
      } else {
        this.formError.set(
          httpErrorMessageI18n(err, this.i18n, this.i18n.t('invite.acceptFailed')),
        );
      }
    } finally {
      this.submitting.set(false);
    }
  }
}
