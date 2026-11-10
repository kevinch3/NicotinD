import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../public/i18n/en.json';
import { LoginComponent } from './login.component';
import { AuthApiService } from '../../services/api/auth-api.service';
import { AuthService } from '../../services/auth.service';
import { TvProfileService } from '../../services/tv-profile.service';

// The TV panel mints a sign-in request on init; keep it off the network.
vi.mock('../../lib/pairing', () => ({
  requestTvLogin: vi.fn(() => new Promise(() => {})),
  pollTvLoginClaim: vi.fn(),
}));

async function mount(over: { recovery?: boolean | 'error'; tv?: boolean } = {}) {
  document.documentElement.classList.toggle('tv-build', over.tv === true);
  TestBed.resetTestingModule();
  const api = {
    getRegistrationStatus: vi.fn(() => of({ enabled: false })),
    getRecoveryStatus: vi.fn(() =>
      over.recovery === 'error'
        ? throwError(() => new Error('down'))
        : of({ enabled: over.recovery ?? false }),
    ),
    login: vi.fn(),
    register: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [LoginComponent],
    providers: [
      provideRouter([]),
      { provide: AuthApiService, useValue: api },
      { provide: AuthService, useValue: { login: vi.fn() } },
      { provide: TvProfileService, useValue: { profiles: signal([]) } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(LoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { fixture, el, q, api, cmp: fixture.componentInstance };
}

afterEach(() => document.documentElement.classList.remove('tv-build'));

describe('LoginComponent — forgot password (docs/email-invitations.md, increment 5)', () => {
  it('links to /forgot-password when recovery is on', async () => {
    const { q } = await mount({ recovery: true });
    const link = q('login-forgot-link');
    expect(link?.getAttribute('href')).toBe('/forgot-password');
    expect(link?.textContent?.trim()).toBe('login.forgot');
    expect(q('login-forgot-ask-admin')).toBeNull();
    expect(BASE_CATALOG['login.forgot']).toBeTruthy();
  });

  it('says to ask the admin when recovery is off, or its status is unknown', async () => {
    for (const recovery of [false, 'error'] as const) {
      const { q } = await mount({ recovery });
      expect(q('login-forgot-link')).toBeNull();
      expect(q('login-forgot-ask-admin')?.textContent?.trim()).toBe('login.forgotAskAdmin');
    }
    expect(BASE_CATALOG['login.forgotAskAdmin']).toBeTruthy();
  });

  it('is hidden while registering', async () => {
    const { q, cmp, fixture } = await mount({ recovery: true });
    cmp.toggleMode();
    fixture.detectChanges();
    expect(q('login-forgot-link')).toBeNull();
  });

  it('never appears on TV, and the TV never asks', async () => {
    const { q, api } = await mount({ recovery: true, tv: true });
    expect(q('login-forgot-link')).toBeNull();
    expect(q('login-forgot-ask-admin')).toBeNull();
    expect(api.getRecoveryStatus).not.toHaveBeenCalled();
  });
});
