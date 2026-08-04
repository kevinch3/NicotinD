import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { DevicesApiService } from '../../services/api/devices-api.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';
import { httpErrorMessageI18n } from '../../lib/http-error';

/**
 * Phone-side approval of a TV's sign-in code (`/approve#c=CODE`, opened by
 * scanning the TV's QR — or typed). Auth-guarded, so an unauthenticated scan
 * bounces through login first (returnUrl round-trip). Approving stamps the
 * pending `login_requests` row; the TV's poll then completes by itself.
 */
@Component({
  selector: 'app-approve-login',
  imports: [TranslatePipe],
  templateUrl: './approve-login.component.html',
})
export class ApproveLoginComponent implements OnInit {
  private api = inject(DevicesApiService);
  private router = inject(Router);
  private i18n = inject(TranslateService);

  readonly code = signal('');
  readonly state = signal<'confirm' | 'approving' | 'done' | 'error'>('confirm');
  readonly deviceName = signal('');
  readonly error = signal('');

  ngOnInit(): void {
    // Fragment first (the QR form), query-param fallback for hand-built links.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = (hash.get('c') ?? '').trim().toUpperCase();
    this.code.set(code);
    if (!code) {
      this.state.set('error');
      this.error.set(this.i18n.t('approve.missingCode'));
    }
  }

  approve(): void {
    this.state.set('approving');
    this.api.approveTvLogin(this.code()).subscribe({
      next: (res) => {
        this.deviceName.set(res.deviceName);
        this.state.set('done');
      },
      error: (err) => {
        this.state.set('error');
        this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('errors.generic')));
      },
    });
  }

  deny(): void {
    // Nothing to revoke server-side — the unapproved request just expires.
    void this.router.navigateByUrl('/');
  }

  goHome(): void {
    void this.router.navigateByUrl('/');
  }
}
