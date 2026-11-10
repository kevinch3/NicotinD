import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { AccountSettingsComponent, accountEmailStatus } from './account-settings.component';
import { AccountApiService, type AccountView } from '../../../services/api/account-api.service';
import { AuthService } from '../../../services/auth.service';
import { ToastService } from '../../../services/toast.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

const VIEW: AccountView = {
  email: 'sam@example.com',
  emailVerified: true,
  pendingEmail: null,
  mailEnabled: true,
};

async function mount(
  changePassword: unknown = vi.fn(() => of({ token: 'fresh' })),
  over: { account?: AccountView; changeEmail?: unknown } = {},
) {
  TestBed.resetTestingModule();
  const auth = { setToken: vi.fn() };
  const toast = { show: vi.fn() };
  const getAccount = vi.fn(() => of(over.account ?? VIEW));
  const changeEmail =
    over.changeEmail ??
    vi.fn(() =>
      of({ ...VIEW, pendingEmail: 'new@example.com', mail: { ok: true, providerId: 'q' } }),
    );
  await TestBed.configureTestingModule({
    imports: [AccountSettingsComponent],
    providers: [
      provideRouter([]),
      { provide: AccountApiService, useValue: { changePassword, getAccount, changeEmail } },
      { provide: AuthService, useValue: auth },
      { provide: ToastService, useValue: toast },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(AccountSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  expandAllGroups(fixture);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return {
    fixture,
    el,
    q,
    settle,
    cmp: fixture.componentInstance,
    auth,
    toast,
    changePassword,
    changeEmail,
  };
}

describe('AccountSettingsComponent', () => {
  it('renders the password form with base-catalog keys', async () => {
    const { el } = await mount();
    expect(el.querySelector('[data-testid="account-password-form"]')).toBeTruthy();
    expect(BASE_CATALOG['account.passwordHint']).toBeTruthy();
  });

  it('only enables saving with the current password and matching 8+ char new ones', async () => {
    const { cmp } = await mount();
    cmp.newPassword.set('longenough');
    cmp.confirmPassword.set('longenough');
    expect(cmp.canSave()).toBe(false);
    cmp.currentPassword.set('old');
    expect(cmp.canSave()).toBe(true);
    cmp.confirmPassword.set('different!');
    expect(cmp.canSave()).toBe(false);
    expect(cmp.mismatch()).toBe(true);
    cmp.newPassword.set('short');
    cmp.confirmPassword.set('short');
    expect(cmp.canSave()).toBe(false);
  });

  it('swaps in the fresh token, clears the form and confirms', async () => {
    const { cmp, auth, toast, changePassword } = await mount();
    cmp.currentPassword.set('old-pass');
    cmp.newPassword.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.save();
    expect(changePassword).toHaveBeenCalledWith('old-pass', 'longenough');
    expect(auth.setToken).toHaveBeenCalledWith('fresh');
    expect(cmp.newPassword()).toBe('');
    expect(toast.show).toHaveBeenCalled();
  });

  it('says plainly when the current password is wrong', async () => {
    const { cmp, auth } = await mount(
      vi.fn(() => throwError(() => ({ error: { code: 'INVALID_CREDENTIALS', error: 'x' } }))),
    );
    cmp.currentPassword.set('wrong');
    cmp.newPassword.set('longenough');
    cmp.confirmPassword.set('longenough');
    await cmp.save();
    expect(cmp.error()).toBe('account.currentPasswordWrong');
    expect(auth.setToken).not.toHaveBeenCalled();
  });

  describe('Email group (increment 5)', () => {
    it('derives the status line from the view', () => {
      expect(accountEmailStatus(VIEW)).toBe('verified');
      expect(accountEmailStatus({ ...VIEW, emailVerified: false })).toBe('unverified');
      expect(accountEmailStatus({ ...VIEW, pendingEmail: 'new@example.com' })).toBe('pending');
      expect(accountEmailStatus({ ...VIEW, email: null })).toBe('none');
      expect(accountEmailStatus(null)).toBe('none');
    });

    it('shows the verified address and prefills the input', async () => {
      const { q, cmp } = await mount();
      expect(q('account-email-status')?.getAttribute('data-status')).toBe('verified');
      expect(q('account-email-status')?.textContent).toContain('sam@example.com');
      expect(cmp.emailInput()).toBe('sam@example.com');
      expect(BASE_CATALOG['account.emailHint']).toBeTruthy();
    });

    it('needs the current password to save', async () => {
      const { q, cmp, settle } = await mount();
      expect((q('account-email-save') as HTMLButtonElement).disabled).toBe(true);
      cmp.emailPassword.set('pw');
      await settle();
      expect((q('account-email-save') as HTMLButtonElement).disabled).toBe(false);
    });

    it('sends the change, then shows it pending and the "sent" line', async () => {
      const { q, cmp, settle, changeEmail } = await mount();
      cmp.emailInput.set(' new@example.com ');
      cmp.emailPassword.set('pw');
      await cmp.saveEmail();
      await settle();
      expect(changeEmail).toHaveBeenCalledWith('new@example.com', 'pw');
      expect(q('account-email-status')?.getAttribute('data-status')).toBe('pending');
      expect(q('account-email-result')?.getAttribute('data-result')).toBe('sent');
      expect(cmp.emailPassword()).toBe('');
      expect(BASE_CATALOG['account.emailSent']).toContain('{email}');
    });

    it('shows the send failure reason', async () => {
      const changeEmail = vi.fn(() =>
        of({
          ...VIEW,
          pendingEmail: 'new@example.com',
          mail: { ok: false, reason: 'auth', detail: '535' },
        }),
      );
      const { q, cmp, settle } = await mount(undefined, { changeEmail });
      cmp.emailInput.set('new@example.com');
      cmp.emailPassword.set('pw');
      await cmp.saveEmail();
      await settle();
      expect(q('account-email-result')?.getAttribute('data-result')).toBe('failed');
      expect(q('account-email-result')?.textContent).toContain('admin.email.reason.auth');
    });

    it('says plainly when the password is wrong or the address is taken', async () => {
      for (const [code, key] of [
        ['INVALID_CREDENTIALS', 'account.currentPasswordWrong'],
        ['EMAIL_TAKEN', 'account.emailTaken'],
      ] as const) {
        const changeEmail = vi.fn(() => throwError(() => ({ error: { code, error: 'x' } })));
        const { cmp } = await mount(undefined, { changeEmail });
        cmp.emailInput.set('new@example.com');
        cmp.emailPassword.set('pw');
        await cmp.saveEmail();
        expect(cmp.emailError()).toBe(key);
      }
    });

    it('an empty address clears it', async () => {
      const changeEmail = vi.fn(() => of({ ...VIEW, email: null, emailVerified: false }));
      const { q, cmp, settle } = await mount(undefined, { changeEmail });
      cmp.emailInput.set('');
      cmp.emailPassword.set('pw');
      await cmp.saveEmail();
      await settle();
      expect(changeEmail).toHaveBeenCalledWith('', 'pw');
      expect(q('account-email-status')?.getAttribute('data-status')).toBe('none');
      expect(q('account-email-result')?.getAttribute('data-result')).toBe('cleared');
    });

    it('is read-only with an explanation while mail is off', async () => {
      const { q, cmp, settle } = await mount(undefined, {
        account: { ...VIEW, mailEnabled: false },
      });
      await settle();
      expect(q('account-email-off')).toBeTruthy();
      expect((q('account-email-input') as HTMLInputElement).disabled).toBe(true);
      cmp.emailPassword.set('pw');
      await settle();
      expect((q('account-email-save') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
