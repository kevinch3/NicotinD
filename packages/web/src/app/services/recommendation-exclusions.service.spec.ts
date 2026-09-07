import { TestBed, getTestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { RecommendationExclusionsService } from './recommendation-exclusions.service';
import { RecommendationsApiService } from './api/recommendations-api.service';
import type { ExcludedSong } from './api/api-types';

const row = (songId: string): ExcludedSong => ({
  songId,
  reason: 'explicit',
  since: 1,
  song: { id: songId, title: songId, artist: 'A' },
});

function setup(api: Partial<Record<keyof RecommendationsApiService, unknown>> = {}) {
  const mock = {
    getExcluded: vi.fn(() => of({ excluded: [row('s1')] })),
    feedback: vi.fn(() => of({ id: 1 })),
    restore: vi.fn(() => of({ ok: true })),
    ...api,
  };
  getTestBed().resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      RecommendationExclusionsService,
      { provide: RecommendationsApiService, useValue: mock },
    ],
  });
  return { svc: TestBed.inject(RecommendationExclusionsService), mock };
}

describe('RecommendationExclusionsService', () => {
  it('loads the excluded set once and answers isExcluded from it', async () => {
    const { svc } = setup();
    expect(svc.isExcluded('s1')).toBe(false);
    await svc.refresh();
    expect(svc.loaded()).toBe(true);
    expect(svc.isExcluded('s1')).toBe(true);
    expect(svc.isExcluded('s2')).toBe(false);
  });

  it('exclude is optimistic and posts an explicit vote', async () => {
    const { svc, mock } = setup();
    await svc.refresh();
    const p = svc.exclude('s2');
    expect(svc.isExcluded('s2')).toBe(true);
    await p;
    expect(mock.feedback).toHaveBeenCalledWith('s2', 'exclude');
  });

  it('exclude reverts when the server rejects it', async () => {
    const { svc } = setup({ feedback: vi.fn(() => throwError(() => new Error('nope'))) });
    await svc.refresh();
    await svc.exclude('s2');
    expect(svc.isExcluded('s2')).toBe(false);
    expect(svc.isExcluded('s1')).toBe(true);
  });

  it('restore removes the row and calls DELETE; reverts on error', async () => {
    const { svc, mock } = setup();
    await svc.refresh();
    await svc.restore('s1');
    expect(svc.isExcluded('s1')).toBe(false);
    expect(mock.restore).toHaveBeenCalledWith('s1');

    const failing = setup({ restore: vi.fn(() => throwError(() => new Error('nope'))) });
    await failing.svc.refresh();
    await failing.svc.restore('s1');
    expect(failing.svc.isExcluded('s1')).toBe(true);
  });
});
