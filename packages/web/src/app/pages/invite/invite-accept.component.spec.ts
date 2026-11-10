import { describe, expect, it, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../public/i18n/en.json';
import { InviteAcceptComponent } from './invite-accept.component';
import { InvitesApiService } from '../../services/api/invites-api.service';
import type { InviteInspection } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';

const pending: InviteInspection = {
  status: 'pending',
  invitedBy: 'boss',
  role: 'listener',
  expiresAt: Date.now() + 1e9,
  serverName: 'home',
};

async function mount(
  over: {
    hash?: string;
    inspection?: InviteInspection;
    inspectError?: boolean;
    accept?: unknown;
    authenticated?: boolean;
  } = {},
) {
  window.history.replaceState(null, '', '/invite' + (over.hash ?? '#t=tok'));
  TestBed.resetTestingModule();
  const api = {
    inspect: vi.fn(() =>
      over.inspectError ? throwError(() => new Error('down')) : of(over.inspection ?? pending),
    ),
    accept:
      over.accept ??
      vi.fn(() => of({ token: 'jwt', user: { id: 'u1', username: 'sam', role: 'listener' } })),
  };
  const auth = {
    isAuthenticated: () => over.authenticated ?? false,
    username: () => 'alice',
    login: vi.fn(),
    logout: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [InviteAcceptComponent],
    providers: [
      provideRouter([]),
      { provide: InvitesApiService, useValue: api },
      { provide: AuthService, useValue: auth },
    ],
  }).compileComponents();
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(InviteAcceptComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { el, q, api, auth, navigate, settle, cmp: fixture.componentInstance };
}

const state = (q: (id: string) => HTMLElement | null) =>
  q('invite-state')?.getAttribute('data-state');

afterEach(() => window.history.replaceState(null, '', '/'));

describe('InviteAcceptComponent', () => {
  it('inspects the fragment token and shows the form', async () => {
    const { q, api } = await mount();
    expect(api.inspect).toHaveBeenCalledWith('tok');
    expect(state(q)).toBe('form');
    expect(q('invite-accept-form')).toBeTruthy();
    // No catalog loads in vitest: the key renders, and it must exist in the base.
    expect(q('invite-summary')?.textContent?.trim()).toBe('invite.summaryBy');
    expect(BASE_CATALOG['invite.summaryBy']).toBeTruthy();
  });

  it('shows an emailed invite’s address read-only', async () => {
    const { q } = await mount({ inspection: { ...pending, email: 'sam@example.com' } });
    const input = q('invite-email') as HTMLInputElement;
    expect(input.value).toBe('sam@example.com');
    expect(input.readOnly).toBe(true);
    expect(BASE_CATALOG['invite.emailHint']).toBeTruthy();
  });

  it('shows no email field for a link invite', async () => {
    const { q } = await mount();
    expect(q('invite-email')).toBeNull();
  });

  it('is invalid without a token, and never calls the server', async () => {
    const { q, api } = await mount({ hash: '' });
    expect(state(q)).toBe('invalid');
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it.each(['expired', 'used', 'revoked'] as const)('shows the %s state', async (status) => {
    const { q } = await mount({ inspection: { status, invitedBy: 'boss', serverName: 'home' } });
    expect(state(q)).toBe(status);
    expect(q('invite-state-message')?.textContent?.trim()).toBe(`invite.state.${status}`);
    expect(BASE_CATALOG[`invite.state.${status}` as keyof typeof BASE_CATALOG]).toBeTruthy();
  });

  it('treats an unreachable server as an invalid link', async () => {
    const { q } = await mount({ inspectError: true });
    expect(state(q)).toBe('invalid');
  });

  it('asks a signed-in visitor to sign out first', async () => {
    const { q, auth, settle } = await mount({ authenticated: true });
    expect(state(q)).toBe('signed-in');
    q('invite-sign-out')!.click();
    await settle();
    expect(auth.logout).toHaveBeenCalled();
    expect(state(q)).toBe('form');
  });

  it('only enables submit for a valid username and matching 8+ char passwords', async () => {
    const { cmp } = await mount();
    cmp.username.set('sam');
    cmp.password.set('short');
    cmp.confirmPassword.set('short');
    expect(cmp.canSubmit()).toBe(false);
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenougH');
    expect(cmp.canSubmit()).toBe(false);
    expect(cmp.passwordsMismatch()).toBe(true);
    cmp.confirmPassword.set('longenough');
    expect(cmp.canSubmit()).toBe(true);
    cmp.username.set('has space');
    expect(cmp.canSubmit()).toBe(false);
  });

  it('accepts, signs in and goes home', async () => {
    const { cmp, api, auth, navigate } = await mount();
    cmp.username.set(' sam ');
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.submit();
    expect(api.accept).toHaveBeenCalledWith('tok', 'sam', 'longenough');
    expect(auth.login).toHaveBeenCalledWith('jwt', 'sam', 'listener');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('keeps the form on a taken username', async () => {
    const { cmp, q, settle } = await mount({
      accept: vi.fn(() =>
        throwError(() => ({ error: { error: 'Username already taken', code: 'USERNAME_TAKEN' } })),
      ),
    });
    cmp.username.set('boss');
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.submit();
    await settle();
    expect(state(q)).toBe('form');
    expect(q('invite-error')?.textContent?.trim()).toBe('errors.usernameTaken');
  });

  it('switches to the terminal state when the invite ran out meanwhile', async () => {
    const { cmp, q, settle } = await mount({
      accept: vi.fn(() => throwError(() => ({ error: { error: 'used', code: 'INVITE_USED' } }))),
    });
    cmp.username.set('sam');
    cmp.password.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.submit();
    await settle();
    expect(state(q)).toBe('used');
  });
});
