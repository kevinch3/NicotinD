import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { ResourcePickerComponent } from './resource-picker.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import type { AlternateSource, AlternateSourcesResult } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';

/** `ref` differs per search: a candidate token is re-minted, the peer's folder is not. */
function peer(username: string, ref = `ref-${username}`): AlternateSource {
  return {
    candidateRef: ref,
    username,
    directory: `Music\\${username}`,
    coveredTitles: ['One'],
    format: 'FLAC',
    estimatedSizeMb: 1,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
  };
}

const found = (alternates: AlternateSource[]): AlternateSourcesResult => ({
  wanted: ['One'],
  required: [],
  alternates,
});

describe('ResourcePickerComponent', () => {
  const searchAlternateSources = vi.fn();
  const resourceJob = vi.fn();

  beforeEach(() => {
    searchAlternateSources.mockReset();
    resourceJob.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: DownloadsApiService, useValue: { searchAlternateSources, resourceJob } },
      ],
    });
  });

  /** The constructor reads its inputs in a microtask, so they are set before it runs. */
  async function open(seed: AlternateSourcesResult | null) {
    const picker = TestBed.createComponent(ResourcePickerComponent).componentInstance;
    setInputValue(picker.jobId, 'job-1');
    setInputValue(picker.seed, seed);
    await Promise.resolve();
    return picker;
  }

  it('shows a search it was handed without running another', async () => {
    const picker = await open(found([peer('best'), peer('other')]));
    expect(searchAlternateSources).not.toHaveBeenCalled();
    expect(picker.searching()).toBe(false);
    expect(picker.selected()?.username).toBe('best');
  });

  it('searches for itself when it was handed nothing', async () => {
    searchAlternateSources.mockReturnValue(of(found([peer('best')])));
    const picker = await open(null);
    expect(searchAlternateSources).toHaveBeenCalledWith('job-1', []);
    expect(picker.selected()?.username).toBe('best');
  });

  it('a refused pick refreshes the list and keeps the chosen peer', async () => {
    const picker = await open(found([peer('best'), peer('other')]));
    picker.choose('ref-other');
    resourceJob.mockReturnValue(throwError(() => ({ status: 400 })));
    searchAlternateSources.mockReturnValue(
      of(found([peer('best', 'new-best'), peer('other', 'new-other')])),
    );
    let done = 0;
    picker.resourced.subscribe(() => done++);

    picker.submit();

    expect(searchAlternateSources).toHaveBeenCalledTimes(1);
    expect(picker.error()).toBe('downloads.resource.refreshed');
    // The same peer under its new token: confirming again reaches the server
    // with a selection it will honour.
    expect(picker.selected()).toMatchObject({ username: 'other', candidateRef: 'new-other' });
    expect(done).toBe(0);
  });

  it('falls back to the best row when the chosen peer is gone from the refresh', async () => {
    const picker = await open(found([peer('best'), peer('other')]));
    picker.choose('ref-other');
    resourceJob.mockReturnValue(throwError(() => ({ status: 400 })));
    searchAlternateSources.mockReturnValue(of(found([peer('best', 'new-best')])));
    picker.submit();
    expect(picker.selected()?.candidateRef).toBe('new-best');
  });

  it('a 409 is not answered with another search', async () => {
    const picker = await open(found([peer('best')]));
    resourceJob.mockReturnValue(throwError(() => ({ status: 409 })));
    picker.submit();
    expect(searchAlternateSources).not.toHaveBeenCalled();
    expect(picker.error()).toBe('downloads.resource.conflict');
  });

  it('reports the peer it switched to', async () => {
    const picker = await open(found([peer('best')]));
    resourceJob.mockReturnValue(of({ ok: true, resourced: 1 }));
    const seen: Array<{ peer: string; count: number }> = [];
    picker.resourced.subscribe((r) => seen.push(r));
    picker.submit();
    expect(resourceJob).toHaveBeenCalledWith('job-1', 'ref-best', ['One']);
    expect(seen).toEqual([{ peer: 'best', count: 1 }]);
  });
});
