import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { GetAlbumCardComponent, type CardLibraryState } from './get-album-card.component';
import { ServerConfigService } from '../../services/server-config.service';
import { setInputValue } from '../../../testing/signal-input';
import type { AlbumHuntStatus } from '../../lib/album-hunt-status';
import { TranslateService, interpolate } from '../../services/translate.service';
import EN from '../../../../public/i18n/en.json';

interface Inputs {
  status: AlbumHuntStatus;
  preparing: boolean;
  availability: string | null | undefined;
  hasCopies: boolean;
  library: CardLibraryState | null;
  showWatch: boolean;
  origin: 'catalog' | 'provider';
  failed: string | null;
}

function render(inputs: Partial<Inputs> = {}) {
  // One fresh component per scenario (signal-input.ts landmine 2).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GetAlbumCardComponent],
    providers: [
      provideRouter([]),
      { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
      {
        provide: TranslateService,
        useValue: {
          lang: signal('en'),
          revision: signal(0),
          t: (key: string, params?: Record<string, string | number>) =>
            interpolate((EN as Record<string, string>)[key] ?? key, params),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(GetAlbumCardComponent);
  const c = fixture.componentInstance;
  setInputValue(c.title, 'Meddle');
  setInputValue(c.artist, 'Pink Floyd');
  setInputValue(c.meta, '1971 · Album · 6 tracks');
  setInputValue(c.status, inputs.status ?? { phase: 'idle' });
  setInputValue(c.preparing, inputs.preparing ?? false);
  setInputValue(c.availability, 'availability' in inputs ? inputs.availability : undefined);
  setInputValue(c.hasCopies, inputs.hasCopies ?? false);
  setInputValue(c.library, inputs.library ?? null);
  setInputValue(c.showWatch, inputs.showWatch ?? false);
  setInputValue(c.origin, inputs.origin ?? 'catalog');
  setInputValue(c.failed, inputs.failed ?? null);
  const emitted = { get: 0, copies: 0, watch: 0, cancel: [] as string[] };
  c.get.subscribe(() => emitted.get++);
  c.copies.subscribe(() => emitted.copies++);
  c.watch.subscribe(() => emitted.watch++);
  c.cancel.subscribe((id) => emitted.cancel.push(id));
  fixture.detectChanges();
  const q = (id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { fixture, emitted, q, text: (id: string) => q(id)?.textContent?.trim() };
}

describe('GetAlbumCardComponent', () => {
  it('idle: Get is an explicit button and the status line is the availability', () => {
    const { q, text, emitted } = render({ availability: '12 peers · FLAC · complete' });
    expect(text('catalog-album-status')).toBe('12 peers · FLAC · complete');
    expect(q('catalog-album-get')!.getAttribute('aria-label')).toBe('Get Meddle');
    q('catalog-album-get')!.click();
    expect(emitted.get).toBe(1);
    expect(q('catalog-album-cancel')).toBeNull();
    expect(q('catalog-album')!.getAttribute('data-availability')).toBe('available');
  });

  it('the cover and the Copies button open the copies, never a Get', () => {
    const { q, emitted } = render({ availability: '2 peers', hasCopies: true });
    q('catalog-album-copies-cover')!.click();
    q('catalog-album-copies')!.click();
    expect(emitted).toMatchObject({ copies: 2, get: 0 });
  });

  it('failed: says so, keeps Get, and opens its copies even with none seen', () => {
    const { q, text, emitted } = render({ availability: undefined, failed: 'No confident match' });
    expect(text('catalog-album-status')).toBe("Couldn't get it — choose a copy");
    expect(q('catalog-album-status')!.getAttribute('title')).toBe('No confident match');
    expect(q('catalog-album')!.getAttribute('data-state')).toBe('failed');
    expect(q('catalog-album-get')).not.toBeNull();
    q('catalog-album-copies')!.click();
    expect(emitted.copies).toBe(1);
  });

  it('a running Get hides an earlier failure', () => {
    const { q } = render({ failed: 'x', status: { phase: 'searching' } });
    expect(q('catalog-album')!.getAttribute('data-state')).toBe('busy');
  });

  it('with no copies the cover is inert', () => {
    const { q } = render({ availability: undefined });
    expect(q('catalog-album-copies-cover')).toBeNull();
    expect(q('catalog-album-copies')).toBeNull();
  });

  it('no copy seen: says so, dims, and still offers Get', () => {
    const { q, text } = render({ availability: null });
    expect(text('catalog-album-status')).toBe('No copy seen yet');
    expect(q('catalog-album')!.getAttribute('data-availability')).toBe('none');
    expect((q('catalog-album-get') as HTMLButtonElement).disabled).toBe(false);
  });

  it('preparing: Get is disabled and the line says so', () => {
    const { q, text } = render({ preparing: true });
    expect(text('catalog-album-hunt-status')).toBe('Preparing…');
    expect((q('catalog-album-get') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a running job swaps Get for Cancel, in the same slot, with its progress', () => {
    const { q, text, emitted } = render({
      status: { phase: 'job', stage: 'downloading', jobId: 'job-3', delivered: 7, expected: 14 },
      availability: '2 peers',
    });
    expect(q('catalog-album-get')).toBeNull();
    expect(text('catalog-album-hunt-status')).toContain('7/14');
    expect(q('catalog-album-progress')!.firstElementChild!.getAttribute('style')).toContain('50%');
    q('catalog-album-cancel')!.click();
    expect(emitted.cancel).toEqual(['job-3']);
    expect(emitted.get).toBe(0);
  });

  it('in the library: Open replaces Get before any click', () => {
    const { q, text } = render({ library: { albumId: 'a1', partial: false } });
    expect(text('catalog-album-status')).toBe('In library');
    expect(q('catalog-album-get')).toBeNull();
    expect(q('catalog-album-open')!.getAttribute('href')).toBe('/library/albums/a1');
    expect(q('catalog-album')!.getAttribute('data-state')).toBe('in-library');
  });

  it('partly in the library: the action completes it', () => {
    const { q, text } = render({ library: { albumId: 'a1', partial: true } });
    expect(text('catalog-album-status')).toBe('Partly in library');
    expect(q('catalog-album-get')!.textContent).toContain('Complete album');
  });

  it('the watch star is its own button, outside every other control', () => {
    const { q, emitted } = render({ showWatch: true });
    const star = q('watchlist-star')!;
    expect(star.tagName).toBe('BUTTON');
    expect(star.parentElement!.closest('button, a')).toBeNull();
    star.click();
    expect(emitted).toMatchObject({ watch: 1, get: 0 });
  });

  it('a provider-only album is the same card, marked by origin', () => {
    const { q } = render({ origin: 'provider', hasCopies: true, availability: '1 peers' });
    expect(q('catalog-album')!.getAttribute('data-origin')).toBe('provider');
    expect(q('catalog-album-get')).not.toBeNull();
  });
});
