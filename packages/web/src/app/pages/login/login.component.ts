import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { AuthApiService } from '../../services/api/auth-api.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { ServerConfigService } from '../../services/server-config.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink, PasswordFieldComponent],
  templateUrl: './login.component.html',
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private api = inject(AuthApiService);
  private router = inject(Router);
  private server = inject(ServerConfigService);

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
        this.router.navigate(['/']);
      },
      error: (err) => {
        this.error.set(err.error?.error ?? err.message ?? 'Something went wrong');
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
