import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../public/i18n/en.json';
import { ResetPasswordComponent } from './reset-password.component';
import { AccountApiService, type ResetInspection } from '../../services/api/account-api.service';
import { AuthService } from '../../services/auth.service';

async function mount(
  over: { hash?: string; inspection?: ResetInspection; complete?: unknown } = {},
) {
  window.history.replaceState(null, '', '/reset-password' + (over.hash ?? '#t=rt'));
  TestBed.resetTestingModule();
  const api = {
    inspectReset: vi.fn(() => of(over.inspection ?? { status: 'valid', username: 'sam' })),
    completeReset:
      over.complete ??
      vi.fn(() => of({ token: 'jwt', user: { id: 'u1', username: 'sam', role: 'user' } })),
  };
  const auth = { login: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ResetPasswordComponent],
    providers: [
      provideRouter([]),
      { provide: AccountApiService, useValue: api },
      { provide: AuthService, useValue: auth },
    ],
  }).compileComponents();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ResetPasswordComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const state = () => el.querySelector('[data-testid="reset-state"]')?.getAttribute('data-state');
  return { el, cmp: fixture.componentInstance, api, auth, navigate, state, fixture };
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('ResetPasswordComponent', () => {
  it('inspects the fragment token and shows the form', async () => {
    const { api, state, el } = await mount();
    expect(api.inspectReset).toHaveBeenCalledWith('rt');
    expect(state()).toBe('form');
    expect(el.querySelector('[data-testid="reset-form"]')).toBeTruthy();
  });

  it('is invalid without a token', async () => {
    const { api, state } = await mount({ hash: '' });
    expect(state()).toBe('invalid');
    expect(api.inspectReset).not.toHaveBeenCalled();
  });

  it.each(['expired', 'used', 'invalid'] as const)('shows the %s state', async (status) => {
    const { state, el } = await mount({ inspection: { status } });
    expect(state()).toBe(status);
    expect(el.querySelector('[data-testid="reset-state-message"]')?.textContent?.trim()).toBe(
      `resetPassword.state.${status}`,
    );
    expect(BASE_CATALOG[`resetPassword.state.${status}` as keyof typeof BASE_CATALOG]).toBeTruthy();
  });

  it('sets the password, signs in and goes home', async () => {
    const { cmp, api, auth, navigate } = await mount();
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.submit();
    expect(api.completeReset).toHaveBeenCalledWith('rt', 'longenough');
    expect(auth.login).toHaveBeenCalledWith('jwt', 'sam', 'user');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('refuses mismatched or short passwords', async () => {
    const { cmp } = await mount();
    cmp.password.set('short');
    cmp.confirmPassword.set('short');
    expect(cmp.canSubmit()).toBe(false);
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenougH');
    expect(cmp.canSubmit()).toBe(false);
  });

  it('switches to the used state when the link was spent meanwhile', async () => {
    const { cmp, state, fixture } = await mount({
      complete: vi.fn(() => throwError(() => ({ error: { code: 'RESET_USED' } }))),
    });
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.submit();
    fixture.detectChanges();
    expect(state()).toBe('used');
  });
});
