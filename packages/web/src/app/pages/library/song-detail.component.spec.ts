import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, of, throwError, Subject } from 'rxjs';
import { signal } from '@angular/core';
import { SongDetailComponent } from './song-detail.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { EntityMenuService } from '../../services/entity-menu.service';
import { OfflineModeService } from '../../services/offline-mode.service';
import { PlayerService } from '../../services/player.service';
import { SongMenuService } from '../../services/song-menu.service';
import { TranslateService } from '../../services/translate.service';
import type { Song } from '../../services/api/api-types';

const SONG = {
  id: 's1',
  title: 'Opening Static',
  artist: 'One & Two',
  artistId: 'compound',
  artists: [
    { id: 'one', name: 'One', role: 'primary' },
    { id: 'two', name: 'Two', role: 'primary' },
  ],
  album: 'Circus',
  albumId: 'al1',
  duration: 185,
  year: 2024,
} as unknown as Song;

function setup(getSong: (id: string) => unknown = () => of(SONG)) {
  const params = new BehaviorSubject(convertToParamMap({ id: 's1' }));
  const route = {
    paramMap: params.asObservable(),
    snapshot: {
      get paramMap() {
        return params.value;
      },
    },
  };
  const router = { navigate: vi.fn() };
  const player = { playSingle: vi.fn(), startRadio: vi.fn() };
  const menu = { open: vi.fn() };
  const offline = signal(false);
  const actions = [{ label: 'Song info', action: () => {} }];
  TestBed.configureTestingModule({
    imports: [SongDetailComponent],
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: router },
      { provide: LibraryApiService, useValue: { getSong: vi.fn(getSong) } },
      { provide: AuthService, useValue: { mediaToken: () => 'tok' } },
      { provide: PlayerService, useValue: player },
      { provide: SongMenuService, useValue: { build: vi.fn(() => actions) } },
      { provide: EntityMenuService, useValue: menu },
      { provide: OfflineModeService, useValue: { isOffline: offline } },
      {
        provide: TranslateService,
        useValue: { t: (k: string) => k, lang: () => 'en', revision: () => 0 },
      },
    ],
  });
  const fixture = TestBed.createComponent(SongDetailComponent);
  const settle = async () => {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  };
  return {
    fixture,
    c: fixture.componentInstance,
    el: fixture.nativeElement as HTMLElement,
    settle,
    params,
    router,
    player,
    menu,
    offline,
    actions,
  };
}
const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('SongDetailComponent', () => {
  it('shows the song: title, album, year and duration', async () => {
    const { el, settle } = setup();
    await settle();
    expect(q(el, 'song-page-title')!.textContent).toContain('Opening Static');
    expect(q(el, 'song-page-album')!.textContent).toContain('2024');
    expect(q(el, 'song-page-album')!.textContent).toContain('3:05');
    expect(q(el, 'song-page-not-found')).toBeNull();
  });

  it('shows a skeleton until the song arrives', async () => {
    const pending = new Subject<Song>();
    const { el, fixture, settle } = setup(() => pending);
    fixture.detectChanges();
    expect(q(el, 'song-page-loading')).not.toBeNull();
    pending.next(SONG);
    pending.complete();
    await settle();
    expect(q(el, 'song-page-loading')).toBeNull();
    expect(q(el, 'song-page-title')).not.toBeNull();
  });

  it('says the song is not in the library for an unknown id', async () => {
    const { el, settle } = setup(() => throwError(() => ({ status: 404 })));
    await settle();
    expect(q(el, 'song-page-not-found')!.textContent).toContain('songPage.notFound');
    expect(q(el, 'song-page-play')).toBeNull();
  });

  it('offline, leaves for the saved songs instead of claiming the song is gone', async () => {
    const env = setup(() => throwError(() => ({ status: 0 })));
    env.offline.set(true);
    await env.settle();
    // Replacing the entry: pushing it would make Back land here and bounce forward again.
    expect(env.router.navigate).toHaveBeenCalledWith(['/library'], {
      queryParams: { find: '' },
      replaceUrl: true,
    });
    expect(env.c.state()).toBe('loading');
  });

  it('a server error is not a missing song: it offers a retry that reloads', async () => {
    let fail = true;
    const { el, settle } = setup(() => (fail ? throwError(() => ({ status: 502 })) : of(SONG)));
    await settle();
    expect(q(el, 'song-page-not-found')).toBeNull();
    expect(q(el, 'song-page-unavailable')!.textContent).toContain('songPage.unavailable');
    fail = false;
    q(el, 'song-page-retry')!.click();
    await settle();
    expect(q(el, 'song-page-title')!.textContent).toContain('Opening Static');
  });

  it('a late failure for a page already left neither redirects nor overwrites', async () => {
    const pending = new Subject<Song>();
    const env = setup(() => pending);
    env.fixture.detectChanges();
    env.offline.set(true);
    env.fixture.destroy();
    pending.error({ status: 0 });
    await Promise.resolve();
    expect(env.router.navigate).not.toHaveBeenCalled();
  });

  it('Play plays the song alone, and Start radio seeds a radio from it', async () => {
    const { el, settle, player } = setup();
    await settle();
    q(el, 'song-page-play')!.click();
    expect(player.playSingle.mock.calls[0]![0]).toMatchObject({
      id: 's1',
      title: 'Opening Static',
    });
    q(el, 'song-page-radio')!.click();
    expect(player.startRadio.mock.calls[0]![0]).toMatchObject({ id: 's1' });
  });

  it("the menu button opens the song's own menu, anchored on it", async () => {
    const { el, settle, menu, actions } = setup();
    await settle();
    const button = q(el, 'song-page-menu')!;
    button.click();
    expect(menu.open).toHaveBeenCalledWith({ actions, anchor: button });
    expect(TestBed.inject(SongMenuService).build).toHaveBeenCalledWith(SONG, {});
  });

  it('loads the next song when the route changes, and drops a late answer for the old one', async () => {
    const first = new Subject<Song>();
    const { c, params, settle } = setup((id) =>
      id === 's1' ? first : of({ ...SONG, id: 's2', title: 'Second Wind' }),
    );
    params.next(convertToParamMap({ id: 's2' }));
    await settle();
    expect(c.song()!.title).toBe('Second Wind');
    first.next(SONG);
    first.complete();
    await settle();
    expect(c.song()!.title).toBe('Second Wind');
  });

  it('drops a late failure for the old song too', async () => {
    const first = new Subject<Song>();
    const { c, params, settle } = setup((id) =>
      id === 's1' ? first : of({ ...SONG, id: 's2', title: 'Second Wind' }),
    );
    params.next(convertToParamMap({ id: 's2' }));
    await settle();
    first.error({ status: 404 });
    await settle();
    expect(c.state()).toBe('ready');
    expect(c.song()!.title).toBe('Second Wind');
  });
});
