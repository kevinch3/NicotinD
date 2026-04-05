import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';

@Component({
  selector: 'app-login',
  imports: [FormsModule, PasswordFieldComponent],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-zinc-950">
      <div class="w-full max-w-sm px-6">
        <h1 class="text-3xl font-bold text-center mb-2 text-zinc-100">NicotinD</h1>
        <p class="text-zinc-500 text-center text-sm mb-8">
          {{ isRegister() ? 'Create an account' : 'Sign in to continue' }}
        </p>

        <form (ngSubmit)="handleSubmit()" class="space-y-4">
          <input
            type="text"
            placeholder="Username"
            [(ngModel)]="username"
            name="username"
            required
            class="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition"
          />
          <app-password-field
            [(ngModel)]="password"
            name="password"
            [placeholder]="'Password'"
            [autocomplete]="'current-password'"
            [required]="true"
            [inputClass]="'px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition'"
          />

          @if (error()) {
            <p class="text-red-400 text-sm">{{ error() }}</p>
          }

          <button
            type="submit"
            [disabled]="loading()"
            class="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
          >
            {{ loading() ? '...' : isRegister() ? 'Create Account' : 'Sign In' }}
          </button>
        </form>

        <button
          (click)="toggleMode()"
          class="w-full mt-4 text-sm text-zinc-500 hover:text-zinc-300 transition"
        >
          {{ isRegister() ? 'Already have an account? Sign in' : "Don't have an account? Register" }}
        </button>
      </div>
    </div>
  `,
})
export class LoginComponent {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private router = inject(Router);

  username = '';
  password = '';
  readonly isRegister = signal(false);
  readonly error = signal('');
  readonly loading = signal(false);

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
