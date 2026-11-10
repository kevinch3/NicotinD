import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../public/i18n/en.json';
import ES_CATALOG from '../../../../public/i18n/es.json';
import { ForgotPasswordComponent } from './forgot-password.component';
import { AuthApiService } from '../../services/api/auth-api.service';

async function mount(over: { enabled?: boolean | 'error'; forgot?: unknown } = {}) {
  TestBed.resetTestingModule();
  const api = {
    getRecoveryStatus: vi.fn(() =>
      over.enabled === 'error'
        ? throwError(() => new Error('down'))
        : of({ enabled: over.enabled ?? true }),
    ),
    forgotPassword: over.forgot ?? vi.fn(() => of({ ok: true })),
  };
  await TestBed.configureTestingModule({
    imports: [ForgotPasswordComponent],
    providers: [provideRouter([]), { provide: AuthApiService, useValue: api }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ForgotPasswordComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { el, q, api, settle, cmp: fixture.componentInstance };
}

const state = (q: (id: string) => HTMLElement | null) =>
  q('forgot-state')?.getAttribute('data-state');

describe('ForgotPasswordComponent', () => {
  it('shows the form when recovery is on', async () => {
    const { q } = await mount();
    expect(state(q)).toBe('form');
    expect(q('forgot-identifier')).toBeTruthy();
    expect((q('forgot-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says to ask the admin when recovery is off or unknown', async () => {
    for (const enabled of [false, 'error'] as const) {
      const { q } = await mount({ enabled });
      expect(state(q)).toBe('disabled');
      expect(q('forgot-disabled')?.textContent?.trim()).toBe('forgot.disabled');
      expect(q('forgot-identifier')).toBeNull();
    }
  });

  it('sends the trimmed identifier and shows the one confirmation', async () => {
    const { q, api, cmp, settle } = await mount();
    cmp.identifier.set('  sam ');
    await cmp.submit();
    await settle();
    expect(api.forgotPassword).toHaveBeenCalledWith('sam');
    expect(state(q)).toBe('sent');
    expect(q('forgot-sent')?.textContent?.trim()).toBe('forgot.sent');
    // The exact sentence the brief promises, in both catalogs.
    expect(BASE_CATALOG['forgot.sent']).toBe(
      "If an account matches and has a verified email, we've sent a reset link. It expires in 30 minutes.",
    );
    expect(ES_CATALOG['forgot.sent']).toBeTruthy();
  });

  it('a failed request still shows the same confirmation', async () => {
    const { q, cmp, settle } = await mount({
      forgot: vi.fn(() => throwError(() => ({ status: 0 }))),
    });
    cmp.identifier.set('whoever');
    await cmp.submit();
    await settle();
    expect(state(q)).toBe('sent');
  });

  it('a rate limit asks to wait and stays on the form', async () => {
    const { q, cmp, settle } = await mount({
      forgot: vi.fn(() => throwError(() => ({ error: { code: 'RATE_LIMITED', error: 'x' } }))),
    });
    cmp.identifier.set('sam');
    await cmp.submit();
    await settle();
    expect(state(q)).toBe('form');
    expect(q('forgot-rate-limited')).toBeTruthy();
  });

  it('"try another" goes back to an empty form', async () => {
    const { q, cmp, settle } = await mount();
    cmp.identifier.set('sam');
    await cmp.submit();
    await settle();
    q('forgot-again')!.click();
    await settle();
    expect(state(q)).toBe('form');
    expect(cmp.identifier()).toBe('');
  });
});
