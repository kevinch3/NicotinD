import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { ImportCardComponent } from './import-card.component';
import { ImportService } from '../../../services/import.service';
import { ConfirmService } from '../../../services/confirm.service';
import type { ImportJob } from '../../../../types/core';

function job(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: 'j1',
    sourcePath: '/mnt/imports',
    removeOriginals: false,
    state: 'done',
    stage: 'done',
    error: null,
    filesTotal: 10,
    filesDone: 10,
    bytesTotal: 100,
    currentDir: null,
    summary: null,
    destinationAlbums: [],
    startedBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

describe('ImportCardComponent', () => {
  const jobs = vi.fn();
  const preview = vi.fn();
  const submit = vi.fn();
  const cancel = vi.fn();
  const ask = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    jobs.mockReset().mockReturnValue(of({ jobs: [] }));
    preview.mockReset().mockReturnValue(of({ files: 3 }));
    submit.mockReset().mockReturnValue(of({ jobId: 'j-new' }));
    cancel.mockReset().mockReturnValue(of({ ok: true }));
    ask.mockReset().mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [ImportCardComponent],
      providers: [
        {
          provide: ImportService,
          useValue: { jobs, preview, submit, cancel, retry: vi.fn(), delete: vi.fn() },
        },
        { provide: ConfirmService, useValue: { ask } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create() {
    return TestBed.createComponent(ImportCardComponent).componentInstance;
  }

  it('does not fetch until the group is opened', () => {
    create();
    expect(jobs).not.toHaveBeenCalled();
  });

  it('load() fetches once; re-load is a no-op (group re-emits opened per expand)', () => {
    const c = create();
    c.load();
    c.load();
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it('polls every 3s while a job is active and stops when it finishes', () => {
    jobs.mockReturnValue(of({ jobs: [job({ state: 'running' })] }));
    const c = create();
    c.load();
    expect(jobs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3100);
    expect(jobs).toHaveBeenCalledTimes(2);
    // Job finished: next tick refreshes once more, then the poll stops.
    jobs.mockReturnValue(of({ jobs: [job({ state: 'done' })] }));
    vi.advanceTimersByTime(3100);
    expect(jobs).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10000);
    expect(jobs).toHaveBeenCalledTimes(3);
  });

  it('move mode asks for confirmation and aborts on decline', async () => {
    ask.mockResolvedValue(false);
    const c = create();
    c.path = '/mnt/imports';
    c.removeOriginals = true;
    await c.start();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('copy mode submits without a confirm dialog', async () => {
    const c = create();
    c.path = '/mnt/imports';
    await c.start();
    expect(ask).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith('/mnt/imports', false);
  });

  it('surfaces the server error message on a failed submit', async () => {
    submit.mockReturnValue(
      // Mimic HttpErrorResponse shape the http-error helper reads.
      {
        subscribe: (h: { error: (e: unknown) => void }) =>
          h.error({ error: { error: 'Not enough free disk space' } }),
      },
    );
    const c = create();
    c.path = '/mnt/imports';
    await c.start();
    expect(c.error()).toBe('Not enough free disk space');
  });

  it('progressPct clamps and survives a zero total', () => {
    const c = create();
    expect(c.progressPct(job({ filesTotal: 0, filesDone: 0 }))).toBe(0);
    expect(c.progressPct(job({ filesTotal: 10, filesDone: 4 }))).toBe(40);
    expect(c.progressPct(job({ filesTotal: 10, filesDone: 99 }))).toBe(100);
  });
});
