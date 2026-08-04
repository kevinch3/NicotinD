import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { AuthApiService } from '../../services/api/auth-api.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { ServerConfigService } from '../../services/server-config.service';
import { sanitizeReturnUrl } from '../../lib/return-url';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';
import { httpErrorMessageI18n } from '../../lib/http-error';
import { isTvUi } from '../../lib/platform';
import { platformId } from '../../services/native/native-capabilities';
import { pollTvLoginClaim, requestTvLogin, type TvLoginRequestResult } from '../../lib/pairing';
import { renderQrDataUrl } from '../../lib/qr';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';

@Component({
  selector: 'app-login',
  imports: [
    FormsModule,
    RouterLink,
    PasswordFieldComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './login.component.html',
})
export class LoginComponent implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private api = inject(AuthApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private server = inject(ServerConfigService);
  private i18n = inject(TranslateService);

  /** Sanitized post-login destination (issue #231), defaults to home. */
  private returnUrl = '/';

  username = '';
  password = '';
  readonly isRegister = signal(false);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly registrationEnabled = signal(true);
  /** Native shell only: login is per-server, so offer the way out to the
   * server-picker — before this link, "log out" trapped you on one server. */
  readonly showServerLink = this.server.native;
  readonly serverHost = hostOf(this.server.baseUrl());

  // ── TV sign-in from phone (issue #389 flow cohesion) ────────────────────
  /** TV builds lead with the approve-from-phone panel; the typed form stays
   *  as the fallback behind `showPasswordForm`. */
  readonly isTv = isTvUi();
  readonly showPasswordForm = signal(false);
  readonly tvLogin = signal<TvLoginRequestResult | null>(null);
  readonly tvQrDataUrl = signal<string | null>(null);
  readonly tvExpired = signal(false);
  private tvPollTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    // Capture where the auth guard wanted to send us (issue #231), sanitized to
    // an in-app path so a crafted link can't open-redirect after login.
    this.returnUrl = sanitizeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
    this.api.getRegistrationStatus().subscribe({
      next: (res) => this.registrationEnabled.set(res.enabled),
      error: () => this.registrationEnabled.set(false),
    });
    if (this.isTv) void this.startTvLogin();
  }

  ngOnDestroy(): void {
    if (this.tvPollTimer) clearTimeout(this.tvPollTimer);
  }

  /** Mint (or re-mint) a sign-in request and start polling it. */
  async startTvLogin(): Promise<void> {
    if (this.tvPollTimer) clearTimeout(this.tvPollTimer);
    this.tvExpired.set(false);
    this.error.set('');
    try {
      const minted = await requestTvLogin(this.server.baseUrl(), {
        deviceName: 'NicotinD TV',
        platform: platformId(),
      });
      this.tvLogin.set(minted);
      // The QR opens the phone's own approval page — code in the fragment so
      // it never reaches proxy logs (the /pair link pattern). Origin: the
      // server's best candidate, falling back to this device's server URL.
      const origin = minted.urls[0] ?? this.server.baseUrl();
      this.tvQrDataUrl.set(await renderQrDataUrl(`${origin}/approve#c=${minted.code}`));
      this.schedulePoll();
    } catch {
      this.error.set(this.i18n.t('errors.generic'));
    }
  }

  /** Recursive setTimeout (never setInterval — a slow round-trip must not
   *  stack, the TransferService convention), bounded by the request TTL. */
  private schedulePoll(): void {
    this.tvPollTimer = setTimeout(() => void this.pollTvLogin(), 2500);
  }

  private async pollTvLogin(): Promise<void> {
    const minted = this.tvLogin();
    if (!minted) return;
    if (Date.now() >= minted.expiresAt) {
      this.tvExpired.set(true);
      return;
    }
    try {
      const result = await pollTvLoginClaim(this.server.baseUrl(), minted.token);
      if ('status' in result) {
        this.schedulePoll();
        return;
      }
      this.auth.login(result.token, result.user.username, result.user.role);
      void this.router.navigateByUrl(this.returnUrl);
    } catch {
      // Expired/consumed server-side — surface the regenerate affordance.
      this.tvExpired.set(true);
    }
  }

  toggleMode(): void {
    this.isRegister.set(!this.isRegister());
    this.error.set('');
  }

  handleSubmit(): void {
    this.error.set('');
    this.loading.set(true);

    const req = this.isRegister()
      ? this.api.register(this.username, this.password)
      : this.api.login(this.username, this.password);

    req.subscribe({
      next: (result) => {
        this.auth.login(result.token, this.username, result.user?.role ?? 'user');
        this.loading.set(false);
        void this.router.navigateByUrl(this.returnUrl);
      },
      error: (err) => {
        this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('errors.generic')));
        this.loading.set(false);
      },
    });
  }
}

function hostOf(url: string): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url;
  }
}
