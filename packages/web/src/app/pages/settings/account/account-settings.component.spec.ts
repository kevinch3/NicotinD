import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { AccountSettingsComponent } from './account-settings.component';
import { AccountApiService } from '../../../services/api/account-api.service';
import { AuthService } from '../../../services/auth.service';
import { ToastService } from '../../../services/toast.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

async function mount(changePassword: unknown = vi.fn(() => of({ token: 'fresh' }))) {
  TestBed.resetTestingModule();
  const auth = { setToken: vi.fn() };
  const toast = { show: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [AccountSettingsComponent],
    providers: [
      provideRouter([]),
      { provide: AccountApiService, useValue: { changePassword } },
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
  return { fixture, el, cmp: fixture.componentInstance, auth, toast, changePassword };
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
});
