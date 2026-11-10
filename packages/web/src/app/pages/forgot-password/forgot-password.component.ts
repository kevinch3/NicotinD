import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthApiService } from '../../services/api/auth-api.service';
import { TranslateService } from '../../services/translate.service';
import { httpErrorCode } from '../../lib/http-error';

export type ForgotPageState = 'loading' | 'form' | 'sent' | 'disabled';

/**
 * `/forgot-password` (docs/email-invitations.md, increment 5). Public, like
 * `/reset-password`: whoever is here cannot sign in.
 *
 * The page says one thing after a submit, whatever the input — the server
 * answers `{ ok: true }` for every identifier, and the page must not undo that
 * by reacting differently. A failed request shows the same confirmation too;
 * only a rate limit (a global budget that never looks at the input, so it
 * reveals nothing about any account) asks to try again later. When the admin
 * has not turned recovery on, or mail is off, the page says to ask them.
 */
@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe],
  templateUrl: './forgot-password.component.html',
})
export class ForgotPasswordComponent implements OnInit {
  private readonly api = inject(AuthApiService);
  readonly i18n = inject(TranslateService);

  readonly state = signal<ForgotPageState>('loading');
  readonly identifier = signal('');
  readonly submitting = signal(false);
  readonly rateLimited = signal(false);

  ngOnInit(): void {
    void this.loadStatus();
  }

  private async loadStatus(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getRecoveryStatus());
      this.state.set(res.enabled ? 'form' : 'disabled');
    } catch {
      this.state.set('disabled');
    }
  }

  canSubmit(): boolean {
    return !this.submitting() && this.identifier().trim().length > 0;
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.submitting.set(true);
    this.rateLimited.set(false);
    try {
      await firstValueFrom(this.api.forgotPassword(this.identifier().trim()));
      this.state.set('sent');
    } catch (err) {
      if (httpErrorCode(err) === 'RATE_LIMITED') this.rateLimited.set(true);
      else this.state.set('sent');
    } finally {
      this.submitting.set(false);
    }
  }

  /** Back to the form for another try — the confirmation stays the same. */
  again(): void {
    this.identifier.set('');
    this.state.set('form');
  }
}
