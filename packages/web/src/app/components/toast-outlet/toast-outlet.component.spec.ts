import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ToastOutletComponent } from './toast-outlet.component';
import { ToastService } from '../../services/toast.service';
import type { Toast } from '../../services/toast.service';

function makeToast(overrides: Partial<Toast> = {}): Toast {
  return {
    id: 'toast-1',
    message: 'Test message',
    kind: 'info',
    ...overrides,
  };
}

describe('ToastOutletComponent', () => {
  const dismiss = vi.fn();
  const toastsSignal = signal<Toast[]>([]);

  function setup() {
    TestBed.configureTestingModule({
      imports: [ToastOutletComponent],
      providers: [
        {
          provide: ToastService,
          useValue: {
            toasts: toastsSignal,
            getCountdownPct: () => 75,
            dismiss,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ToastOutletComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    dismiss.mockClear();
    toastsSignal.set([]);
  });

  it('renders nothing when there are no toasts', () => {
    const fixture = setup();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="toast"]').length).toBe(0);
  });

  it('renders a toast message', () => {
    toastsSignal.set([makeToast({ message: 'Hello world' })]);
    const fixture = setup();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Hello world');
  });

  it('renders action buttons and calls their callbacks on click', () => {
    const cb = vi.fn();
    toastsSignal.set([
      makeToast({ actions: [{ label: 'Do it', callback: cb }] }),
    ]);
    const fixture = setup();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="toast-action-0"]') as HTMLButtonElement;
    btn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('renders a countdown progress bar when countdown is set', () => {
    toastsSignal.set([makeToast({ countdown: 3 })]);
    const fixture = setup();
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('[data-testid="toast-progress"]');
    expect(bar).not.toBeNull();
  });

  it('applies error kind styling', () => {
    toastsSignal.set([makeToast({ kind: 'error' })]);
    const fixture = setup();
    fixture.detectChanges();
    const toast = fixture.nativeElement.querySelector('[data-testid="toast"]');
    expect(toast?.className).toContain('border-red');
  });
});
