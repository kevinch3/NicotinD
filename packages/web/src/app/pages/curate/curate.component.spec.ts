import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import CurateComponent from './curate.component';
import { CurationApiService } from '../../services/api/curation-api.service';
import { ToastService } from '../../services/toast.service';
import type { CurationCase } from '../../services/api/api-types';

// NOTE on what these assertions observe (and why):
//
// Under this project's JIT vitest harness, Angular does not register signal
// inputs on a *nested imported* component (see testing/signal-input.ts), so
// the host's `[case]="c"` binding onto <app-case-card> never lands and the
// card always renders its own null branch here. Asserting on text the CARD
// would have rendered (e.g. a case's title) would pass or fail for reasons
// that have nothing to do with this component. So every assertion below is
// on something the HOST itself owns: the service calls, the host's own
// signals (`current()`, `done()`, `index()`, `total()`), and DOM the host
// template renders directly (the progress counter, the done/empty state).
const aCase = (id: string): CurationCase => ({
  id,
  kind: 'identity',
  target: { kind: 'song', id: 's1', title: `T-${id}`, subtitle: 'sub' },
  question: 'q',
  evidence: [],
  options: [{ id: 'resolve', label: 'Mark handled', rationale: 'no change' }],
  confidence: 1,
  source: 'flag',
});

describe('CurateComponent', () => {
  const getRound = vi.fn();
  const applyCase = vi.fn();
  const show = vi.fn();

  beforeEach(async () => {
    getRound.mockReset();
    applyCase.mockReset();
    show.mockReset();
    getRound.mockReturnValue(of({ cases: [aCase('flag:1'), aCase('flag:2')] }));
    applyCase.mockReturnValue(of({ ok: true, detail: 'done' }));

    await TestBed.configureTestingModule({
      imports: [CurateComponent],
      providers: [
        { provide: CurationApiService, useValue: { getRound, applyCase, getCount: vi.fn() } },
        { provide: ToastService, useValue: { show } },
      ],
    }).compileComponents();
  });

  it('loads a round and shows the first case', () => {
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    expect(getRound).toHaveBeenCalledTimes(1);
    expect(f.componentInstance.current()?.id).toBe('flag:1');
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="curate-progress"]')
        ?.textContent,
    ).toContain('1 / 2');
  });

  it('advances to the next case after a choice is applied', () => {
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    f.componentInstance.onChoose('resolve');
    f.detectChanges();
    expect(applyCase).toHaveBeenCalledWith('flag:1', 'resolve');
    expect(f.componentInstance.current()?.id).toBe('flag:2');
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="curate-progress"]')
        ?.textContent,
    ).toContain('2 / 2');
  });

  it('shows the done state after the last case', () => {
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    f.componentInstance.onChoose('resolve');
    f.componentInstance.onChoose('resolve');
    f.detectChanges();
    expect(f.componentInstance.done()).toBe(true);
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="curate-done"]'),
    ).not.toBeNull();
  });

  it('skip advances without applying anything', () => {
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    f.componentInstance.onSkip();
    f.detectChanges();
    expect(applyCase).not.toHaveBeenCalled();
    expect(f.componentInstance.current()?.id).toBe('flag:2');
  });

  it('keeps the case in place and toasts when applying fails', () => {
    applyCase.mockReturnValue(throwError(() => new Error('nope')));
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    f.componentInstance.onChoose('resolve');
    f.detectChanges();
    expect(show).toHaveBeenCalled();
    expect(f.componentInstance.index()).toBe(0);
    expect(f.componentInstance.current()?.id).toBe('flag:1');
  });

  it('renders the empty state when the round has no cases', () => {
    getRound.mockReturnValue(of({ cases: [] }));
    const f = TestBed.createComponent(CurateComponent);
    f.detectChanges();
    expect(f.componentInstance.done()).toBe(true);
    expect(f.componentInstance.total()).toBe(0);
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="curate-next-round"]'),
    ).toBeNull();
  });
});
