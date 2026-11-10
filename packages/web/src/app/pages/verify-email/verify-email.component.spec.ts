import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../public/i18n/en.json';
import ES_CATALOG from '../../../../public/i18n/es.json';
import { VerifyEmailComponent } from './verify-email.component';
import { AuthApiService } from '../../services/api/auth-api.service';
import { AuthService } from '../../services/auth.service';

async function mount(over: { hash?: string; verify?: unknown; authenticated?: boolean } = {}) {
  window.history.replaceState(null, '', '/verify-email' + (over.hash ?? '#t=tok'));
  TestBed.resetTestingModule();
  const api = {
    verifyEmail: over.verify ?? vi.fn(() => of({ ok: true, email: 'sam@example.com' })),
  };
  await TestBed.configureTestingModule({
    imports: [VerifyEmailComponent],
    providers: [
      provideRouter([]),
      { provide: AuthApiService, useValue: api },
      { provide: AuthService, useValue: { isAuthenticated: () => over.authenticated ?? false } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(VerifyEmailComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { q, api };
}

const state = (q: (id: string) => HTMLElement | null) =>
  q('verify-state')?.getAttribute('data-state');

afterEach(() => window.history.replaceState(null, '', '/'));

describe('VerifyEmailComponent', () => {
  it('spends the fragment token and says the address is confirmed', async () => {
    const { q, api } = await mount();
    expect(api.verifyEmail).toHaveBeenCalledWith('tok');
    expect(state(q)).toBe('done');
    expect(q('verify-email')?.textContent?.trim()).toBe('verifyEmail.done');
    expect(BASE_CATALOG['verifyEmail.done']).toContain('{email}');
  });

  it('is invalid without a token, and never calls the server', async () => {
    const { q, api } = await mount({ hash: '' });
    expect(state(q)).toBe('invalid');
    expect(api.verifyEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['VERIFY_INVALID', 'invalid'],
    ['VERIFY_EXPIRED', 'expired'],
    ['VERIFY_USED', 'used'],
    ['EMAIL_TAKEN', 'taken'],
    ['SOMETHING_ELSE', 'invalid'],
  ])('maps %s to the %s state', async (code, expected) => {
    const { q } = await mount({
      verify: vi.fn(() => throwError(() => ({ error: { code, error: code } }))),
    });
    expect(state(q)).toBe(expected);
    if (expected !== 'done') {
      const key = `verifyEmail.state.${expected}` as keyof typeof BASE_CATALOG;
      expect(BASE_CATALOG[key]).toBeTruthy();
      expect(ES_CATALOG[key as keyof typeof ES_CATALOG]).toBeTruthy();
    }
  });

  it('points a signed-in user back to Settings → Account, others to sign in', async () => {
    expect((await mount({ authenticated: true })).q('verify-continue')?.getAttribute('href')).toBe(
      '/settings/account',
    );
    expect((await mount()).q('verify-continue')?.getAttribute('href')).toBe('/login');
  });
});
