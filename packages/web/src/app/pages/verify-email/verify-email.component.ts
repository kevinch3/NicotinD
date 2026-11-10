import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthApiService } from '../../services/api/auth-api.service';
import { AuthService } from '../../services/auth.service';
import { httpErrorCode } from '../../lib/http-error';
import { parseInviteToken } from '../../lib/invite-link';

export type VerifyPageState = 'loading' | 'done' | 'invalid' | 'expired' | 'used' | 'taken';

const STATE_FOR_CODE: Record<string, VerifyPageState> = {
  VERIFY_INVALID: 'invalid',
  VERIFY_EXPIRED: 'expired',
  VERIFY_USED: 'used',
  EMAIL_TAKEN: 'taken',
};

/**
 * `/verify-email#t=<token>` (docs/email-invitations.md, increment 5): where a
 * verification link lands. Public — the link may be opened on a phone that was
 * never signed in — and the token rides in the fragment like every other link
 * this server mails. Opening it is the whole action: the address becomes the
 * account's email, verified.
 */
@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  templateUrl: './verify-email.component.html',
})
export class VerifyEmailComponent implements OnInit {
  private readonly api = inject(AuthApiService);
  readonly auth = inject(AuthService);

  readonly state = signal<VerifyPageState>('loading');
  readonly email = signal('');

  ngOnInit(): void {
    void this.verify(parseInviteToken(window.location.hash, window.location.search));
  }

  private async verify(token: string | null): Promise<void> {
    if (!token) {
      this.state.set('invalid');
      return;
    }
    try {
      const res = await firstValueFrom(this.api.verifyEmail(token));
      this.email.set(res.email);
      this.state.set('done');
    } catch (err) {
      this.state.set(STATE_FOR_CODE[httpErrorCode(err) ?? ''] ?? 'invalid');
    }
  }
}
