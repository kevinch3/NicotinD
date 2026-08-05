import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { ReviewInboxComponent } from './review-inbox.component';
import { DownloadReviewService } from '../../services/download-review.service';
import { ReviewApiService } from '../../services/api/review-api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { ReviewQueueAlbum } from '../../services/api/api-types';

function album(over: Partial<ReviewQueueAlbum> = {}): ReviewQueueAlbum {
  return {
    albumId: 'a1',
    albumTitle: 'Some Album',
    albumArtist: 'Some Artist',
    year: 2020,
    songs: [
      {
        id: 's1',
        title: 'Track One',
        track: 1,
        steps: {
          download: 'done',
          bpm: 'done',
          key: 'pending',
          energy: 'pending',
          genre: 'pending',
          mood: 'pending',
        },
      },
    ],
    ...over,
  };
}

function setup(
  opts: {
    canCurate?: boolean;
    queueAlbums?: ReviewQueueAlbum[];
    confirmResult?: boolean;
  } = {},
) {
  const queue = signal<ReviewQueueAlbum[]>(opts.queueAlbums ?? [album()]);
  const reviewStub = {
    pending: signal(0),
    queue,
    loading: signal(false),
    start: vi.fn(() => () => {}),
    watchQueue: vi.fn(() => () => {}),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const apiStub = {
    approve: vi.fn().mockReturnValue(of({ ok: true })),
    discard: vi.fn().mockReturnValue(of({ ok: true, deletedCount: 1 })),
  };
  const authStub = {
    canCurate: signal(opts.canCurate ?? true),
    token: signal('tok'),
  };
  const confirmStub = {
    ask: vi.fn().mockResolvedValue(opts.confirmResult ?? true),
  };
  const toastStub = {
    show: vi.fn(),
  };
  // Stub rather than the real catalog-backed service: the raw `en.json` text
  // has no `{album}` in its own key name, so asserting interpolation content
  // needs a stub that actually substitutes params (the real service's
  // `interpolate` logic, applied to a synthetic template).
  const i18nStub = {
    t: vi.fn((key: string, params?: Record<string, string | number>) =>
      params ? `${key}::${JSON.stringify(params)}` : key,
    ),
  };
  const playerStub = {
    playSingle: vi.fn(),
  };
  const transfersStub = {
    markLibraryDirty: vi.fn(),
  };
  const libraryStub = {
    getSong: vi.fn().mockReturnValue(
      of({
        id: 's1',
        title: 'Track One',
        artist: 'Some Artist',
        album: 'Some Album',
        albumId: 'a1',
      }),
    ),
  };

  TestBed.configureTestingModule({
    imports: [ReviewInboxComponent],
    providers: [
      { provide: DownloadReviewService, useValue: reviewStub },
      { provide: ReviewApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: ConfirmService, useValue: confirmStub },
      { provide: ToastService, useValue: toastStub },
      { provide: TranslateService, useValue: i18nStub },
      { provide: PlayerService, useValue: playerStub },
      { provide: TransferService, useValue: transfersStub },
      { provide: LibraryApiService, useValue: libraryStub },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(ReviewInboxComponent);
  return {
    component: fixture.componentInstance,
    reviewStub,
    apiStub,
    confirmStub,
    toastStub,
    playerStub,
    transfersStub,
    libraryStub,
  };
}

describe('ReviewInboxComponent', () => {
  it('is visible when the curator has a non-empty queue', () => {
    const { component } = setup({ canCurate: true, queueAlbums: [album()] });
    expect(component.visible()).toBe(true);
  });

  it('is hidden when the queue is empty', () => {
    const { component } = setup({ canCurate: true, queueAlbums: [] });
    expect(component.visible()).toBe(false);
  });

  it('is hidden when the user cannot curate, even with a non-empty queue', () => {
    const { component } = setup({ canCurate: false, queueAlbums: [album()] });
    expect(component.visible()).toBe(false);
  });

  it('approve() calls api.approve, then refreshes and flags the library dirty, then toasts', async () => {
    const { component, apiStub, reviewStub, transfersStub, toastStub } = setup();
    const a = album();
    await component.approve(a);
    expect(apiStub.approve).toHaveBeenCalledWith('a1');
    expect(reviewStub.refresh).toHaveBeenCalled();
    expect(transfersStub.markLibraryDirty).toHaveBeenCalled();
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'review.approved' }),
    );
  });

  it('discard() asks ConfirmService with a message naming the album', async () => {
    const { component, confirmStub } = setup();
    const a = album({ albumTitle: 'My Great Album' });
    await component.discard(a);
    expect(confirmStub.ask).toHaveBeenCalled();
    const message = confirmStub.ask.mock.calls[0][0] as string;
    expect(message).toContain('My Great Album');
  });

  it('discard() does not call the API when the user declines the confirm dialog', async () => {
    const { component, apiStub } = setup({ confirmResult: false });
    await component.discard(album());
    expect(apiStub.discard).not.toHaveBeenCalled();
  });

  it('discard() calls api.discard, refreshes, flags dirty and toasts when confirmed', async () => {
    const { component, apiStub, reviewStub, transfersStub, toastStub } = setup({
      confirmResult: true,
    });
    const a = album();
    await component.discard(a);
    expect(apiStub.discard).toHaveBeenCalledWith('a1');
    expect(reviewStub.refresh).toHaveBeenCalled();
    expect(transfersStub.markLibraryDirty).toHaveBeenCalled();
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'review.discarded' }),
    );
  });

  it('listen() fetches the first song by id and plays it', async () => {
    const { component, libraryStub, playerStub } = setup();
    const a = album();
    await component.listen(a);
    expect(libraryStub.getSong).toHaveBeenCalledWith('s1');
    expect(playerStub.playSingle).toHaveBeenCalled();
  });
});
