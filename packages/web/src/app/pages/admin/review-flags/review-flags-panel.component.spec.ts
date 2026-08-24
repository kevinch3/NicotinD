import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ReviewFlagsPanelComponent } from './review-flags-panel.component';
import { ServiceReviewService } from '../../../services/service-review.service';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import type { CurationFlag } from '../../../services/api/api-types';

/**
 * Issue #682. The panel is a slice of the shared ServiceReview snapshot plus one
 * write, so the cases worth holding are: it renders the queue, Resolve hides the
 * row immediately rather than waiting for the next snapshot, and a failed
 * resolve leaves the row in place.
 */
describe('ReviewFlagsPanelComponent', () => {
  const flags = signal<CurationFlag[]>([]);
  const resolveReviewFlag = vi.fn();
  const show = vi.fn();

  beforeEach(async () => {
    flags.set([
      {
        id: 1,
        targetKind: 'artist',
        targetId: 'Secret Cinema B2B Egbert',
        reason: 'two acts',
        createdBy: 'agent:t1',
        createdAt: 1,
      },
      {
        id: 2,
        targetKind: 'song',
        targetId: 's9',
        reason: 'wrong artist?',
        createdBy: 'kevin',
        createdAt: 2,
      },
    ]);
    resolveReviewFlag.mockReset();
    resolveReviewFlag.mockReturnValue(of({ ok: true }));
    show.mockReset();

    await TestBed.configureTestingModule({
      imports: [ReviewFlagsPanelComponent],
      providers: [
        { provide: ServiceReviewService, useValue: { reviewFlags: flags } },
        { provide: LibraryApiService, useValue: { resolveReviewFlag } },
        { provide: ToastService, useValue: { show } },
        { provide: TranslateService, useValue: { t: (k: string) => k } },
      ],
    }).compileComponents();
  });

  const create = () => TestBed.createComponent(ReviewFlagsPanelComponent).componentInstance;

  it('lists the open flags from the shared snapshot', () => {
    const c = create();
    expect(c.openFlags().map((f) => f.id)).toEqual([1, 2]);
  });

  it('resolve() hides the row immediately instead of waiting for the next snapshot', () => {
    const c = create();
    c.resolve(1);
    expect(resolveReviewFlag).toHaveBeenCalledWith(1);
    expect(c.openFlags().map((f) => f.id)).toEqual([2]);
    expect(c.resolving()).toBeNull();
  });

  it('a failed resolve keeps the row and surfaces a toast', () => {
    resolveReviewFlag.mockReturnValueOnce(throwError(() => new Error('boom')));
    const c = create();
    c.resolve(1);
    expect(c.openFlags().map((f) => f.id)).toEqual([1, 2]);
    expect(c.resolving()).toBeNull();
    expect(show).toHaveBeenCalledWith({ message: 'admin.reviewFlagResolveFailed', kind: 'error' });
  });

  it('ignores a second resolve while one is in flight', () => {
    resolveReviewFlag.mockReturnValueOnce(of()); // never emits — stays in flight
    const c = create();
    c.resolve(1);
    c.resolve(2);
    expect(resolveReviewFlag).toHaveBeenCalledTimes(1);
  });
});
