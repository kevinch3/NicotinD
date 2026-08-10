import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { PrivacySettingsComponent } from './privacy.component';
import { HistoryApiService } from '../../../services/api/history-api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ListeningQueueService } from '../../../services/listening-queue.service';
import { ToastService } from '../../../services/toast.service';
import type { PrivacyState } from '../../../services/api/api-types';

function state(over: Partial<PrivacyState> = {}): PrivacyState {
  return {
    historyEnabled: true,
    collection: { enabled: true, blockedBy: null },
    retentionDays: 0,
    ...over,
  };
}

function setup(
  opts: {
    privacy?: PrivacyState;
    confirm?: boolean;
    deleteResult?: { deleted: number } | 'error';
  } = {},
) {
  const setHistoryConsent = vi.fn((enabled: boolean) =>
    of(
      state({
        historyEnabled: enabled,
        collection: { enabled, blockedBy: enabled ? null : 'user' },
      }),
    ),
  );
  const deleteMyHistory = vi.fn(() =>
    opts.deleteResult === 'error'
      ? throwError(() => new Error('nope'))
      : of(opts.deleteResult ?? { deleted: 3 }),
  );
  const resetConsentState = vi.fn();
  const show = vi.fn();

  TestBed.configureTestingModule({
    imports: [PrivacySettingsComponent],
    providers: [
      provideRouter([]),
      {
        provide: HistoryApiService,
        useValue: {
          getPrivacy: () => of(opts.privacy ?? state()),
          setHistoryConsent,
          deleteMyHistory,
          exportMyData: () => of({ user: { id: 'u1' } }),
        },
      },
      { provide: ConfirmService, useValue: { ask: () => Promise.resolve(opts.confirm ?? true) } },
      { provide: ListeningQueueService, useValue: { resetConsentState } },
      { provide: ToastService, useValue: { show } },
    ],
  });
  const fixture = TestBed.createComponent(PrivacySettingsComponent);
  fixture.detectChanges();
  return {
    fixture,
    cmp: fixture.componentInstance,
    setHistoryConsent,
    deleteMyHistory,
    resetConsentState,
    show,
  };
}

/**
 * Every `<app-settings-group>` renders collapsed by default (the repo-wide
 * settings-cards rule), so its body is not in the DOM until opened. Click each
 * still-closed toggle before asserting on content.
 */
async function settle(f: {
  whenStable: () => Promise<unknown>;
  detectChanges: () => void;
  nativeElement: HTMLElement;
}) {
  await f.whenStable();
  f.detectChanges();
  for (const t of Array.from(
    f.nativeElement.querySelectorAll<HTMLButtonElement>('[data-testid="settings-group-toggle"]'),
  )) {
    if (!f.nativeElement.querySelector('[data-testid="privacy-consent-toggle"]')) t.click();
  }
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
}

describe('PrivacySettingsComponent', () => {
  it('renders what is stored — transparency is the point of the page', async () => {
    const { fixture } = setup();
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="privacy-what"]')).toBeTruthy();
  });

  it('reflects the current consent on the toggle', async () => {
    const { fixture } = setup();
    await settle(fixture);
    const toggle = fixture.nativeElement.querySelector('[data-testid="privacy-consent-toggle"]');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(false);
  });

  it('turns collection off and tells the reporter to stop', async () => {
    const { fixture, setHistoryConsent, resetConsentState } = setup();
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-testid="privacy-consent-toggle"]').click();
    await settle(fixture);

    expect(setHistoryConsent).toHaveBeenCalledWith(false);
    // Turning OFF must not reset the client's stop-flag.
    expect(resetConsentState).not.toHaveBeenCalled();
  });

  it('resumes reporting immediately when turned back on', async () => {
    const { fixture, resetConsentState } = setup({
      privacy: state({ historyEnabled: false, collection: { enabled: false, blockedBy: 'user' } }),
    });
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-testid="privacy-consent-toggle"]').click();
    await settle(fixture);
    expect(resetConsentState).toHaveBeenCalled();
  });

  it('disables the toggle and explains when the environment locked it', async () => {
    // Offering a control that silently does nothing is worse than explaining.
    const { fixture } = setup({
      privacy: state({ collection: { enabled: false, blockedBy: 'env' } }),
    });
    await settle(fixture);

    expect(
      fixture.nativeElement.querySelector('[data-testid="privacy-consent-toggle"]').disabled,
    ).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="privacy-locked"]')).toBeTruthy();
  });

  it('disables the toggle when the instance turned collection off', async () => {
    const { fixture, cmp } = setup({
      privacy: state({ collection: { enabled: false, blockedBy: 'instance' } }),
    });
    await settle(fixture);
    expect(cmp.toggleUsable()).toBe(false);
    expect(cmp.lockedReason()).toBe('privacy.lockedInstance');
  });

  it('leaves the toggle usable when the user is the one who turned it off', async () => {
    const { fixture, cmp } = setup({
      privacy: state({ historyEnabled: false, collection: { enabled: false, blockedBy: 'user' } }),
    });
    await settle(fixture);
    expect(cmp.toggleUsable()).toBe(true);
    expect(cmp.lockedReason()).toBeNull();
  });

  it('deletes history after confirmation and reports the count', async () => {
    const { fixture, deleteMyHistory, show } = setup({ deleteResult: { deleted: 42 } });
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-testid="privacy-delete-history"]').click();
    await settle(fixture);

    expect(deleteMyHistory).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });

  it('does not delete when the confirmation is declined', async () => {
    const { fixture, deleteMyHistory } = setup({ confirm: false });
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-testid="privacy-delete-history"]').click();
    await settle(fixture);
    expect(deleteMyHistory).not.toHaveBeenCalled();
  });

  it('surfaces a failed deletion rather than silently doing nothing', async () => {
    const { fixture, show } = setup({ deleteResult: 'error' });
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-testid="privacy-delete-history"]').click();
    await settle(fixture);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('offers an export button', async () => {
    const { fixture } = setup();
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="privacy-export"]')).toBeTruthy();
  });
});
