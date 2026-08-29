import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, computed, signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ReviewInboxComponent, aggregateAlbumSteps } from './review-inbox.component';
import type { QuarantineSong } from '../../services/api/api-types';
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
    // Mirrors the real service's derivation (#894) — the component delegates to
    // this rather than recomputing it, so the stub has to be faithful.
    inboxVisible: computed(() => (opts.canCurate ?? true) && queue().length > 0),
    start: vi.fn(() => () => {}),
    watchQueue: vi.fn(() => () => {}),
    refresh: vi.fn().mockResolvedValue(undefined),
    forceRefresh: vi.fn().mockResolvedValue(undefined),
    dropFromQueue: vi.fn((ids: string[]) => {
      const drop = new Set(ids);
      queue.update((q) => q.filter((a) => !drop.has(a.albumId)));
    }),
  };
  const apiStub = {
    approve: vi.fn().mockReturnValue(of({ ok: true })),
    discard: vi.fn().mockReturnValue(of({ ok: true, deletedCount: 1 })),
    approveAll: vi.fn((ids: string[]) => of({ approved: ids, notFound: [] as string[] })),
    discardAll: vi.fn((ids: string[]) =>
      of({ discarded: ids, notFound: [] as string[], failed: [] as string[] }),
    ),
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
    // The `t` pipe reads `lang()` to know when to re-evaluate; only the specs
    // that actually render the template need it.
    lang: signal('en'),
  };
  const playerStub = {
    playSingle: vi.fn(),
  };
  const transfersStub = {
    markLibraryDirty: vi.fn(),
    noteAlbumsLanded: vi.fn(),
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
    fixture,
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
    expect(reviewStub.dropFromQueue).toHaveBeenCalledWith(['a1']);
    expect(reviewStub.forceRefresh).toHaveBeenCalled();
    expect(transfersStub.markLibraryDirty).toHaveBeenCalled();
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'review.approved' }),
    );
  });

  it('approve() surfaces a failure as a toast and keeps the row (#808)', async () => {
    const { component, apiStub, toastStub, reviewStub } = setup();
    apiStub.approve.mockReturnValue(throwError(() => ({ status: 500, error: { error: 'boom' } })));
    await component.approve(album());
    expect(toastStub.show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(reviewStub.dropFromQueue).not.toHaveBeenCalled();
  });

  it('approve() on a 404 drops the stale row — a concurrent decision beat it (#808)', async () => {
    const { component, apiStub, reviewStub, toastStub } = setup();
    apiStub.approve.mockReturnValue(
      throwError(() => ({ status: 404, error: { error: 'Album not found' } })),
    );
    await component.approve(album());
    expect(reviewStub.dropFromQueue).toHaveBeenCalledWith(['a1']);
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'review.alreadyRemoved' }),
    );
  });

  it('a second click on the same card while one is in flight is a no-op (#808)', async () => {
    const { component, apiStub } = setup();
    let resolve!: (v: { ok: boolean }) => void;
    apiStub.approve.mockReturnValue(
      new (await import('rxjs')).Observable((sub) => {
        resolve = (v) => {
          sub.next(v);
          sub.complete();
        };
      }),
    );
    const first = component.approve(album());
    void component.approve(album());
    expect(apiStub.approve).toHaveBeenCalledTimes(1);
    expect(component.busyAlbums().has('a1')).toBe(true);
    resolve({ ok: true });
    await first;
    expect(component.busyAlbums().has('a1')).toBe(false);
  });

  it('approve() notes the album landed only when the server confirms landed: true (issue #708)', async () => {
    const { component, apiStub, transfersStub } = setup();
    apiStub.approve.mockReturnValue(of({ ok: true, landed: true }));
    await component.approve(album());
    expect(transfersStub.noteAlbumsLanded).toHaveBeenCalledWith(['a1']);
  });

  it('approve() does not note landing while it is still processing (landed: false)', async () => {
    const { component, apiStub, transfersStub } = setup();
    apiStub.approve.mockReturnValue(of({ ok: true, landed: false, timedOut: true }));
    await component.approve(album());
    expect(transfersStub.noteAlbumsLanded).not.toHaveBeenCalled();
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
    expect(reviewStub.dropFromQueue).toHaveBeenCalledWith(['a1']);
    expect(reviewStub.forceRefresh).toHaveBeenCalled();
    expect(transfersStub.markLibraryDirty).toHaveBeenCalled();
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'review.discarded' }),
    );
  });

  // Issue #592 — prod had 34 pending albums with no way to clear the queue
  // other than one card at a time. #808 turned the client's N-POST loop into
  // ONE bulk request: the old sweep took minutes (each approve blocked on
  // landAlbumNow since #708) and a mid-sweep reload stranded the remainder.
  it('approveAll() confirms with the count, sends ONE bulk request, drops the queue live', async () => {
    const albums = [album({ albumId: 'a1' }), album({ albumId: 'a2' }), album({ albumId: 'a3' })];
    const { component, apiStub, confirmStub, reviewStub, transfersStub, toastStub } = setup({
      queueAlbums: albums,
    });
    await component.approveAll();
    expect(confirmStub.ask).toHaveBeenCalled();
    expect(String(confirmStub.ask.mock.calls[0][0])).toContain('3');
    expect(apiStub.approveAll).toHaveBeenCalledTimes(1);
    expect(apiStub.approveAll).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
    expect(apiStub.approve).not.toHaveBeenCalled();
    expect(reviewStub.dropFromQueue).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
    expect(reviewStub.forceRefresh).toHaveBeenCalledTimes(1);
    expect(transfersStub.markLibraryDirty).toHaveBeenCalledTimes(1);
    expect(toastStub.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('review.bulkApproved') }),
    );
  });

  it('approveAll() never claims landed — the background drain owns visibility (#708)', async () => {
    const { component, transfersStub } = setup({ queueAlbums: [album({ albumId: 'a1' })] });
    await component.approveAll();
    expect(transfersStub.noteAlbumsLanded).not.toHaveBeenCalled();
  });

  it('approveAll() does nothing when the confirm is declined', async () => {
    const { component, apiStub, reviewStub } = setup({
      confirmResult: false,
      queueAlbums: [album({ albumId: 'a1' })],
    });
    await component.approveAll();
    expect(apiStub.approveAll).not.toHaveBeenCalled();
    expect(reviewStub.forceRefresh).not.toHaveBeenCalled();
  });

  it('discardAll() confirms with the count and sends one bulk request', async () => {
    const albums = [album({ albumId: 'a1' }), album({ albumId: 'a2' })];
    const { component, apiStub, confirmStub } = setup({ queueAlbums: albums });
    await component.discardAll();
    expect(String(confirmStub.ask.mock.calls[0][0])).toContain('2');
    expect(apiStub.discardAll).toHaveBeenCalledWith(['a1', 'a2']);
  });

  it('discardAll() does nothing when the confirm is declined', async () => {
    const { component, apiStub } = setup({
      confirmResult: false,
      queueAlbums: [album({ albumId: 'a1' })],
    });
    await component.discardAll();
    expect(apiStub.discardAll).not.toHaveBeenCalled();
  });

  it('discardAll() reports a server-side partial result honestly', async () => {
    const albums = [album({ albumId: 'a1' }), album({ albumId: 'a2' }), album({ albumId: 'a3' })];
    const { component, apiStub, toastStub } = setup({ queueAlbums: albums });
    apiStub.discardAll.mockReturnValue(
      of({ discarded: ['a1', 'a3'], notFound: [], failed: ['a2'] }),
    );
    await component.discardAll();
    const msg = String(toastStub.show.mock.calls.at(-1)?.[0]?.message ?? '');
    expect(msg).toContain('review.bulkPartial');
  });

  it('a failed bulk request surfaces as an error toast, never a silent no-op (#808)', async () => {
    const { component, apiStub, toastStub } = setup({ queueAlbums: [album({ albumId: 'a1' })] });
    apiStub.approveAll.mockReturnValue(
      throwError(() => ({ status: 500, error: { error: 'boom' } })),
    );
    await component.approveAll();
    expect(toastStub.show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(component.bulkBusy()).toBe(false);
  });

  // The mid-sweep window the old synchronous stubs could never observe: while
  // the bulk request is pending, every per-row button reports disabled.
  it('per-row actions are disabled for the whole bulk window (#808)', async () => {
    const { Subject } = await import('rxjs');
    const pending = new Subject<{ approved: string[]; notFound: string[] }>();
    const albums = [album({ albumId: 'a1' }), album({ albumId: 'a2' })];
    const { component, apiStub } = setup({ queueAlbums: albums });
    apiStub.approveAll.mockReturnValue(pending.asObservable());

    const run = component.approveAll();
    // Let the confirm promise resolve and the request fire.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(component.bulkBusy()).toBe(true);
    // The single-action guard refuses while the sweep runs.
    await component.approve(albums[0]!);
    expect(apiStub.approve).not.toHaveBeenCalled();

    pending.next({ approved: ['a1', 'a2'], notFound: [] });
    pending.complete();
    await run;
    expect(component.bulkBusy()).toBe(false);
  });

  it('bulkBusy() is false once a bulk run settles', async () => {
    const { component } = setup({ queueAlbums: [album()] });
    expect(component.bulkBusy()).toBe(false);
    await component.approveAll();
    expect(component.bulkBusy()).toBe(false);
  });

  it('listen() fetches the first song by id and plays it', async () => {
    const { component, libraryStub, playerStub } = setup();
    const a = album();
    await component.listen(a);
    expect(libraryStub.getSong).toHaveBeenCalledWith('s1');
    expect(playerStub.playSingle).toHaveBeenCalled();
  });

  it('stepsFor() aggregates one badge set per album, not per song', () => {
    const { component } = setup();
    const a = album({
      songs: [
        song({
          id: 's1',
          steps: {
            download: 'done',
            bpm: 'done',
            key: 'done',
            energy: 'done',
            genre: 'done',
            mood: 'done',
          },
        }),
        song({
          id: 's2',
          steps: {
            download: 'done',
            bpm: 'done',
            key: 'done',
            energy: 'done',
            genre: 'done',
            mood: 'done',
          },
        }),
      ],
    });
    expect(Object.keys(component.stepsFor(a))).toEqual(['bpm', 'key', 'energy', 'genre', 'mood']);
  });
});

function song(over: Partial<QuarantineSong> = {}): QuarantineSong {
  return {
    id: 's1',
    title: 'Track',
    track: 1,
    steps: {
      download: 'done',
      bpm: 'done',
      key: 'done',
      energy: 'done',
      genre: 'done',
      mood: 'done',
    },
    ...over,
  };
}

describe('aggregateAlbumSteps', () => {
  it('reports the worst state per step across the album (pending beats skipped beats done)', () => {
    const songs: QuarantineSong[] = [
      song({
        id: 's1',
        steps: {
          download: 'done',
          bpm: 'done',
          key: 'pending',
          energy: 'skipped',
          genre: 'done',
          mood: 'done',
        },
      }),
      song({
        id: 's2',
        steps: {
          download: 'done',
          bpm: 'skipped',
          key: 'done',
          energy: 'skipped',
          genre: 'done',
          mood: 'pending',
        },
      }),
      song({
        id: 's3',
        steps: {
          download: 'done',
          bpm: 'done',
          key: 'done',
          energy: 'done',
          genre: 'skipped',
          mood: 'done',
        },
      }),
    ];

    expect(aggregateAlbumSteps(songs)).toEqual({
      bpm: 'skipped', // done, skipped, done → skipped
      key: 'pending', // pending, done, done → pending
      energy: 'skipped', // skipped, skipped, done → skipped
      genre: 'skipped', // done, done, skipped → skipped
      mood: 'pending', // done, pending, done → pending
    });
  });

  it('reports done when every song is done for that step', () => {
    const songs: QuarantineSong[] = [song({ id: 's1' }), song({ id: 's2' })];
    expect(aggregateAlbumSteps(songs)).toEqual({
      bpm: 'done',
      key: 'done',
      energy: 'done',
      genre: 'done',
      mood: 'done',
    });
  });

  it('returns done for every step on an empty song list (vacuous — no song contradicts done)', () => {
    expect(aggregateAlbumSteps([])).toEqual({
      bpm: 'done',
      key: 'done',
      energy: 'done',
      genre: 'done',
      mood: 'done',
    });
  });
});

/**
 * #746. The card said "98 pistas" and nothing else, so approving an album meant
 * trusting a count. The titles were already in the DTO and rendered nowhere.
 */
describe('ReviewInboxComponent tracklist', () => {
  const STEPS: QuarantineSong['steps'] = {
    download: 'done',
    bpm: 'done',
    key: 'done',
    energy: 'done',
    genre: 'done',
    mood: 'done',
  };
  const THREE = album({
    songs: [
      { id: 's1', title: 'Output-Input', track: 1, steps: STEPS },
      { id: 's2', title: 'El salmón', track: 2, steps: STEPS },
      { id: 's3', title: 'Días distintos', track: null, steps: STEPS },
    ],
  });

  it('lists every quarantined track with its number', () => {
    const { fixture } = setup({ canCurate: true, queueAlbums: [THREE] });
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll(
      '[data-testid="review-tracklist-row"]',
    ) as NodeListOf<HTMLElement>;
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('Output-Input');
    expect(rows[1].textContent).toContain('El salmón');
  });

  /** An untracked song still gets a row — omitting it would understate the album. */
  it('renders a track with no number rather than dropping it', () => {
    const { fixture } = setup({ canCurate: true, queueAlbums: [THREE] });
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="review-tracklist-row"]');
    expect(rows[2].textContent).toContain('Días distintos');
    expect(rows[2].textContent).toContain('—');
  });
});
