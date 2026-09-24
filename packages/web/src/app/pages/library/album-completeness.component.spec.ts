import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AlbumCompletenessComponent } from './album-completeness.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import type { AlbumCompleteness } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';

const INCOMPLETE: AlbumCompleteness = {
  albumId: 'al1',
  confirmed: { expected: 12, owned: 9, missing: 3 },
};

describe('AlbumCompletenessComponent (issue #737)', () => {
  const getAlbumCompleteness = vi.fn();
  const completeAlbum = vi.fn();
  const show = vi.fn();
  const canCurate = signal(true);
  const canAcquire = signal(true);

  beforeEach(async () => {
    TestBed.resetTestingModule();
    getAlbumCompleteness.mockReset().mockReturnValue(of(INCOMPLETE));
    completeAlbum
      .mockReset()
      .mockReturnValue(of({ ok: true, outcome: 'enqueued', lidarrAlbumId: 5 }));
    show.mockReset();
    canCurate.set(true);
    canAcquire.set(true);
    await TestBed.configureTestingModule({
      imports: [AlbumCompletenessComponent],
      providers: [
        { provide: LibraryApiService, useValue: { getAlbumCompleteness, completeAlbum } },
        { provide: AuthService, useValue: { canCurate, canAcquire } },
        { provide: ToastService, useValue: { show } },
        {
          provide: TranslateService,
          useValue: {
            t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k),
            lang: () => 'en',
            revision: () => 0,
          },
        },
      ],
    }).compileComponents();
  });

  async function render(albumId = 'al1') {
    const fixture = TestBed.createComponent(AlbumCompletenessComponent);
    setInputValue(fixture.componentInstance.albumId, albumId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      badge: () => el.querySelector('[data-testid="album-incomplete-badge"]'),
      action: () =>
        el.querySelector('[data-testid="album-complete-action"]') as HTMLButtonElement | null,
    };
  }

  it('renders "N of M" from the album-scoped endpoint, never the report', async () => {
    const { badge } = await render();
    expect(getAlbumCompleteness).toHaveBeenCalledWith('al1');
    expect(badge()?.textContent).toContain('album.incompleteBadge');
    expect(badge()?.textContent).toContain('"owned":9');
    expect(badge()?.textContent).toContain('"expected":12');
  });

  it('renders nothing for an album that is not confirmed incomplete', async () => {
    getAlbumCompleteness.mockReturnValue(of({ albumId: 'al1', confirmed: null }));
    const { badge, action } = await render();
    expect(badge()).toBeNull();
    expect(action()).toBeNull();
  });

  it('hides the badge when the read fails', async () => {
    getAlbumCompleteness.mockReturnValue(throwError(() => new Error('boom')));
    const { badge } = await render();
    expect(badge()).toBeNull();
  });

  it('offers the Complete action to curators only', async () => {
    canCurate.set(false);
    const { badge, action } = await render();
    expect(badge()).not.toBeNull();
    expect(action()).toBeNull();
  });

  it('disables the action under the acquisition kill-switch', async () => {
    canAcquire.set(false);
    const { action } = await render();
    expect(action()?.disabled).toBe(true);
    action()!.click();
    expect(completeAlbum).not.toHaveBeenCalled();
  });

  it('calls the only-missing-tracks path and stops offering it once hunting', async () => {
    const { fixture, action } = await render();
    action()!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(completeAlbum).toHaveBeenCalledWith('al1');
    expect(show).toHaveBeenCalledWith({
      kind: 'success',
      message: 'album.completeOutcome.enqueued',
    });
    expect(action()?.disabled).toBe(true);
  });

  it('surfaces already-complete as a notice and leaves the action available', async () => {
    completeAlbum.mockReturnValue(of({ ok: true, outcome: 'already-complete', lidarrAlbumId: 5 }));
    const { fixture, action } = await render();
    action()!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(show).toHaveBeenCalledWith({
      kind: 'info',
      message: 'album.completeOutcome.already-complete',
    });
    expect(action()?.disabled).toBe(false);
  });

  it("appends a failure's addon detail and reports a request error", async () => {
    completeAlbum.mockReturnValue(
      of({ ok: true, outcome: 'enqueue-failed', detail: 'addon 400', lidarrAlbumId: 5 }),
    );
    const { fixture, action } = await render();
    action()!.click();
    await fixture.whenStable();
    expect(show).toHaveBeenLastCalledWith({
      kind: 'error',
      message: 'album.completeOutcome.enqueue-failed — addon 400',
    });

    completeAlbum.mockReturnValue(throwError(() => new Error('500')));
    fixture.detectChanges();
    action()!.click();
    await fixture.whenStable();
    expect(show).toHaveBeenLastCalledWith({ kind: 'error', message: 'album.completeFailed' });
  });
});
