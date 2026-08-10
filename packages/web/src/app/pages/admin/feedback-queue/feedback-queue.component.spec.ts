import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { FeedbackQueueComponent } from './feedback-queue.component';
import { FeedbackService } from '../../../services/feedback.service';
import { FeedbackSheetService } from '../../../services/feedback-sheet.service';
import type { GenerationFeedbackSummary } from '../../../../types/core';

function summary(over: Partial<GenerationFeedbackSummary> = {}): GenerationFeedbackSummary {
  return {
    id: 1,
    at: 1785848319240,
    username: 'boss',
    resourceType: 'hunt-match',
    resourceRef: '5885',
    verdict: null,
    note: null,
    engineVersion: '0.1.303',
    artistName: 'Valentino Jazz Bazar',
    albumTitle: 'Jazz Bazar',
    ...over,
  };
}

describe('FeedbackQueueComponent', () => {
  const listSummaries = vi.fn();
  const getOne = vi.fn();
  const resolve = vi.fn();
  const open = vi.fn();

  beforeEach(async () => {
    listSummaries.mockReset().mockReturnValue(of([summary()]));
    getOne.mockReset();
    resolve.mockReset().mockReturnValue(of({ ok: true }));
    open.mockReset();

    await TestBed.configureTestingModule({
      imports: [FeedbackQueueComponent],
      providers: [
        { provide: FeedbackService, useValue: { listSummaries, getOne, resolve } },
        { provide: FeedbackSheetService, useValue: { open } },
      ],
    }).compileComponents();
  });

  function create() {
    return TestBed.createComponent(FeedbackQueueComponent).componentInstance;
  }

  it('does not fetch until the group is opened — it is an on-demand dev list', () => {
    create();
    expect(listSummaries).not.toHaveBeenCalled();
  });

  it('loads pending captures on first open, and not again on re-open', () => {
    const c = create();
    c.load();
    c.load();
    expect(listSummaries).toHaveBeenCalledTimes(1);
    expect(c.rows()).toHaveLength(1);
  });

  it('👍 grades a row good and flips its verdict in place', () => {
    const c = create();
    c.load();
    c.grade(c.rows()[0], 'good');

    expect(resolve).toHaveBeenCalledWith(1, 'good');
    expect(c.rows()[0].verdict).toBe('good');
  });

  it('👎 fetches the full record and opens the grading sheet with its candidates', () => {
    getOne.mockReturnValue(
      of({
        id: 1,
        input: { artistName: 'Valentino Jazz Bazar', albumTitle: 'Jazz Bazar' },
        output: {
          candidates: [
            { username: 'bob', directory: 'B/Jazz', matchPct: 80, format: 'MP3 320kbps' },
          ],
        },
      }),
    );

    const c = create();
    c.load();
    c.openSheet(c.rows()[0]);

    expect(getOne).toHaveBeenCalledWith(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackId: 1,
        albumTitle: 'Jazz Bazar',
        candidates: [expect.objectContaining({ username: 'bob' })],
      }),
    );
  });

  it('survives a capture whose output has no candidates', () => {
    getOne.mockReturnValue(of({ id: 1, input: {}, output: null }));
    const c = create();
    c.load();
    c.openSheet(c.rows()[0]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
  });
});
