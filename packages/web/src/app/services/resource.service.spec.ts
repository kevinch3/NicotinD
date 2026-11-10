import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { ResourceService, RESOURCE_COUNTDOWN_SECONDS } from './resource.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService, type ToastConfig } from './toast.service';
import { TranslateService } from './translate.service';
import type { AlternateSource, AlternateSourcesResult } from './api/api-types';

function peer(username: string, covered: string[]): AlternateSource {
  return {
    candidateRef: `ref-${username}`,
    username,
    directory: `Music\\${username}`,
    coveredTitles: covered,
    format: 'FLAC',
    estimatedSizeMb: 100,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
  };
}

const WANTED = ['One', 'Two'];
const found = (alternates: AlternateSource[]): AlternateSourcesResult => ({
  wanted: WANTED,
  required: [],
  alternates,
});

describe('ResourceService', () => {
  const searchAlternateSources = vi.fn();
  const resourceJob = vi.fn();
  const kickPoll = vi.fn();
  const show = vi.fn<ToastService['show']>();
  const dismiss = vi.fn();
  /** False models ToastService dropping a toast at its cap: shown, never on screen. */
  let toastsVisible = true;
  const toasts = () => (toastsVisible ? [{ id: 'toast-id' }] : []);
  let service: ResourceService;

  const lastToast = (): ToastConfig => show.mock.calls.at(-1)![0];
  const act = (label: string) =>
    lastToast()
      .actions!.find((a) => a.label === label)!
      .callback();

  beforeEach(() => {
    searchAlternateSources.mockReset();
    resourceJob.mockReset();
    kickPoll.mockReset();
    kickPoll.mockResolvedValue(undefined);
    show.mockReset();
    show.mockReturnValue('toast-id');
    dismiss.mockReset();
    toastsVisible = true;

    TestBed.configureTestingModule({
      providers: [
        ResourceService,
        { provide: DownloadsApiService, useValue: { searchAlternateSources, resourceJob } },
        { provide: TransferService, useValue: { kickPoll } },
        { provide: ToastService, useValue: { show, dismiss, toasts } },
        // Keys stand in for copy: the assertions are about which message, not its wording.
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    });
    service = TestBed.inject(ResourceService);
  });

  it('holds the card while it searches, and asks for the ticked titles', () => {
    searchAlternateSources.mockReturnValue(new Subject());
    service.start('job-1', ['One']);
    expect(service.isBusy('job-1')).toBe(true);
    expect(service.isBusy('job-2')).toBe(false);
    expect(searchAlternateSources).toHaveBeenCalledWith('job-1', ['One']);
    expect(service.picker()).toBeNull();
  });

  it('ignores a second click on a card it is already working on', () => {
    searchAlternateSources.mockReturnValue(new Subject());
    service.start('job-1', []);
    service.start('job-1', []);
    expect(searchAlternateSources).toHaveBeenCalledTimes(1);
  });

  it('offers the best peer behind a countdown instead of opening the picker', () => {
    searchAlternateSources.mockReturnValue(
      of(found([peer('best', WANTED), peer('other', ['One'])])),
    );
    service.start('job-1', []);

    expect(service.picker()).toBeNull();
    const toast = lastToast();
    expect(toast.countdown).toBe(RESOURCE_COUNTDOWN_SECONDS);
    expect(toast.message).toBe('downloads.resource.auto');
    // The countdown fires actions[0], so that must be the switch itself.
    expect(toast.actions![0].label).toBe('downloads.resource.useNow');
    expect(resourceJob).not.toHaveBeenCalled();
    expect(service.isBusy('job-1')).toBe(true);
  });

  it('switches to the best peer when the countdown runs out', async () => {
    const best = peer('best', WANTED);
    searchAlternateSources.mockReturnValue(of(found([best, peer('other', ['One'])])));
    resourceJob.mockReturnValue(of({ ok: true, resourced: 2 }));
    service.start('job-1', []);

    lastToast().actions![0].callback();
    await vi.waitFor(() => expect(service.isBusy('job-1')).toBe(false));

    expect(resourceJob).toHaveBeenCalledWith('job-1', best.candidateRef, best.coveredTitles);
    expect(lastToast()).toMatchObject({ message: 'downloads.resource.started', kind: 'success' });
    expect(kickPoll).toHaveBeenCalled();
    expect(service.isBusy('job-1')).toBe(false);
  });

  it('Cancel leaves the stuck download alone', () => {
    searchAlternateSources.mockReturnValue(of(found([peer('best', WANTED)])));
    service.start('job-1', []);
    act('downloads.resource.cancel');
    expect(resourceJob).not.toHaveBeenCalled();
    expect(service.isBusy('job-1')).toBe(false);
  });

  it('Choose peer opens the picker on the results already fetched', () => {
    const res = found([peer('best', WANTED), peer('other', ['One'])]);
    searchAlternateSources.mockReturnValue(of(res));
    service.start('job-1', ['One']);
    act('downloads.resource.choose');

    expect(service.picker()).toEqual({ jobId: 'job-1', titles: ['One'], seed: res });
    expect(resourceJob).not.toHaveBeenCalled();
    expect(service.isBusy('job-1')).toBe(true);

    service.closePicker();
    expect(service.picker()).toBeNull();
    expect(service.isBusy('job-1')).toBe(false);
  });

  it('falls back to the picker when the toast cap drops the countdown', () => {
    const res = found([peer('best', WANTED)]);
    toastsVisible = false;
    searchAlternateSources.mockReturnValue(of(res));
    service.start('job-1', []);
    expect(service.picker()).toEqual({ jobId: 'job-1', titles: [], seed: res });
  });

  it('says nobody has the tracks, without a picker, when the search comes back empty', () => {
    searchAlternateSources.mockReturnValue(of(found([])));
    service.start('job-1', []);
    expect(lastToast()).toMatchObject({ message: 'downloads.resource.none', kind: 'error' });
    expect(lastToast().countdown).toBeUndefined();
    expect(service.picker()).toBeNull();
    expect(service.isBusy('job-1')).toBe(false);
  });

  it('tells an offline source from an empty one', () => {
    searchAlternateSources.mockReturnValue(of({ ...found([]), sourceOffline: true }));
    service.start('job-1', []);
    expect(lastToast().message).toBe('downloads.resource.offline');
  });

  it('reports a failed search and frees the card', () => {
    searchAlternateSources.mockReturnValue(throwError(() => new Error('504')));
    service.start('job-1', []);
    expect(lastToast()).toMatchObject({
      message: 'downloads.resource.searchFailed',
      kind: 'error',
    });
    expect(service.isBusy('job-1')).toBe(false);
  });

  it('a refused switch offers the picker, which searches afresh', () => {
    searchAlternateSources.mockReturnValue(of(found([peer('best', WANTED)])));
    resourceJob.mockReturnValue(throwError(() => ({ status: 400 })));
    service.start('job-1', ['One']);
    lastToast().actions![0].callback();

    expect(lastToast()).toMatchObject({ message: 'downloads.resource.failed', kind: 'error' });
    expect(service.isBusy('job-1')).toBe(false);
    act('downloads.resource.choose');
    expect(service.picker()).toEqual({ jobId: 'job-1', titles: ['One'], seed: null });
    expect(service.isBusy('job-1')).toBe(true);
  });

  it('a 409 is the source still holding the album, not something to search again for', () => {
    searchAlternateSources.mockReturnValue(of(found([peer('best', WANTED)])));
    resourceJob.mockReturnValue(throwError(() => ({ status: 409 })));
    service.start('job-1', []);
    lastToast().actions![0].callback();

    expect(lastToast().message).toBe('downloads.resource.conflict');
    expect(lastToast().actions!.map((a) => a.label)).toEqual(['downloads.dismiss']);
  });

  it('a pick made in the picker is announced and frees the card', async () => {
    searchAlternateSources.mockReturnValue(of(found([peer('best', WANTED)])));
    service.start('job-1', []);
    act('downloads.resource.choose');

    await service.picked({ peer: 'other', count: 1 });
    expect(service.picker()).toBeNull();
    expect(lastToast()).toMatchObject({ message: 'downloads.resource.started', kind: 'success' });
    expect(kickPoll).toHaveBeenCalled();
    expect(service.isBusy('job-1')).toBe(false);
  });
});
