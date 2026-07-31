import { Component, inject, signal, OnInit } from '@angular/core';
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

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink, PasswordFieldComponent, TranslatePipe],
  templateUrl: './login.component.html',
})
export class LoginComponent implements OnInit {
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

  ngOnInit(): void {
    // Capture where the auth guard wanted to send us (issue #231), sanitized to
    // an in-app path so a crafted link can't open-redirect after login.
    this.returnUrl = sanitizeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
    this.api.getRegistrationStatus().subscribe({
      next: (res) => this.registrationEnabled.set(res.enabled),
      error: () => this.registrationEnabled.set(false),
    });
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
