import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { TrackRowComponent } from './track-row.component';
import { EntityLinkComponent } from '../entity-link/entity-link.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { PlayerService, type Track } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { LikeService } from '../../services/like.service';
import { setInputValue } from '../../../testing/signal-input';

const ROW_TRACK: Track = { id: 't1', title: 'Song One', artist: 'Artist A' };
const OTHER_TRACK: Track = { id: 't2', title: 'Song Two', artist: 'Artist B' };

/**
 * Signal inputs are driven via the shared `setInputValue` helper — the JIT
 * harness registers no signal inputs, so neither a `[foo]="…"` binding nor
 * `componentRef.setInput()` reaches them. The full rationale, the measured
 * no-op of the supported API, and the call-before-detectChanges rule live in
 * `src/testing/signal-input.ts`. Here the row itself is the unit under test, so
 * it renders the real production template rather than a stub.
 */
describe('TrackRowComponent — current-track indicator', () => {
  function setup(
    opts: {
      album?: { id?: string; name: string };
      subtitle?: string;
      artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
    } = {},
  ) {
    TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [
        PlayerService,
        provideRouter([{ path: '**', children: [] }]),
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(TrackRowComponent);
    setInputValue(fixture.componentInstance.track, ROW_TRACK);
    setInputValue(fixture.componentInstance.indexLabel, 3);
    setInputValue(fixture.componentInstance.showCover, false);
    if (opts.album) setInputValue(fixture.componentInstance.album, opts.album);
    if (opts.subtitle) setInputValue(fixture.componentInstance.subtitle, opts.subtitle);
    if (opts.artists) setInputValue(fixture.componentInstance.artists, opts.artists);
    const player = TestBed.inject(PlayerService);
    player.clear();
    fixture.detectChanges();
    const row = () =>
      fixture.nativeElement.querySelector('[data-testid="track-row"]') as HTMLElement;
    return { fixture, player, row };
  }

  it('shows the index and no playback state when the row is not current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(OTHER_TRACK);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBeNull();
    expect(row().textContent).toContain('3');
    expect(row().querySelector('.eq-bars')).toBeNull();
  });

  it('acknowledges instantly: current + buffering shows a spinner in the index slot', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.bufferingVisible.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('buffering');
    expect(row().querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows animated equalizer bars while playing', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('playing');
    const bars = row().querySelector('.eq-bars');
    expect(bars).not.toBeNull();
    expect(bars!.classList.contains('eq-paused')).toBe(false);
  });

  it('shows static bars while paused and accents the title when current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(false);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('paused');
    expect(row().querySelector('.eq-bars.eq-paused')).not.toBeNull();
    const title = row().querySelector('[data-testid="track-row-title"] p') as HTMLElement;
    expect(title.classList.contains('text-theme-accent-text')).toBe(true);
  });

  // The JIT harness does not land a nested component's signal inputs (see
  // src/testing/signal-input.ts, landmine 1), so `<app-entity-link>` renders
  // here with its defaults — the href, the missing-id span and the click that
  // must not bubble into `play` are asserted in entity-link.component.spec.ts,
  // and the rendered link is exercised end to end in e2e/tests/entity-links.spec.ts.
  // What this spec can pin is the row's wiring: the album is a nested
  // EntityLinkComponent placed between the credits and the plain subtitle.
  it('places the album entity link between the credits and the subtitle', () => {
    const { row, fixture } = setup({
      artists: [{ id: 'ar1', name: 'Artist A', role: 'primary' }],
      album: { id: 'al1', name: 'Album One' },
      subtitle: '2024',
    });
    fixture.detectChanges();
    const line = row().querySelector('[data-testid="track-row-subtitle"]') as HTMLElement;
    const order = Array.from(line.childNodes)
      .map((n) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element).tagName.toLowerCase() : ''))
      .filter(Boolean);
    expect(order).toEqual(['app-artist-links', 'span', 'app-entity-link', 'span', 'span']);
    expect(fixture.debugElement.query(By.directive(EntityLinkComponent))).not.toBeNull();
    expect(line.textContent!.replace(/\s+/g, ' ').trim()).toContain('· 2024');
  });

  it('with only an album, renders the entity link and no separator', () => {
    const { row, fixture } = setup({ album: { id: 'al1', name: 'Album One' } });
    fixture.detectChanges();
    const line = row().querySelector('[data-testid="track-row-subtitle"]') as HTMLElement;
    expect(line.querySelectorAll('app-entity-link').length).toBe(1);
    expect(line.textContent).not.toContain('·');
  });

  it('a plain subtitle alone still renders as text', () => {
    const { row, fixture } = setup({ subtitle: 'Just text' });
    fixture.detectChanges();
    const line = row().querySelector('[data-testid="track-row-subtitle"]') as HTMLElement;
    expect(line.textContent!.trim()).toBe('Just text');
    expect(line.querySelector('app-entity-link')).toBeNull();
  });

  it('renders no second line when there are no credits, album or subtitle', () => {
    const { row, fixture } = setup();
    fixture.detectChanges();
    expect(row().querySelector('[data-testid="track-row-subtitle"]')).toBeNull();
  });

  it('the title button is a valid D-pad nav item (marked appTvNavItem)', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const title: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="track-row-title"]',
    );
    expect(title.hasAttribute('appTvNavItem')).toBe(true);
  });
});

/**
 * The regression guard for the cross-component-boundary bug: `appTvNavItem`
 * sits inside `TrackRowComponent`'s OWN template, while the `appTvNavGroup`
 * wrapping `<app-track-row>` lives in a consumer page's template. An Angular
 * `@ContentChildren` query stops at that view boundary, so the group saw zero
 * items — while each item's `inject(TvNavGroupDirective)` (which DOES cross
 * it) still found the group and pinned itself to `tabindex="-1"`, removing
 * every song title from the Tab order on all five consumer pages.
 *
 * This is asserted here rather than in one of the five consumer page specs
 * (album/genre/playlist detail, library-songs, artist-detail Songs tab)
 * because all five run with `NO_ERRORS_SCHEMA` and deliberately do NOT render
 * real `<app-track-row>` elements — the JIT harness can't bind a nested
 * component's signal inputs (see `src/testing/signal-input.ts`), so those
 * specs stub the rows out entirely. `track-row.component.spec.ts` already
 * renders the real production row template, so hosting two of them under a
 * real group here is the only place the actual boundary is exercised.
 */
describe('TrackRowComponent inside an appTvNavGroup (cross-component boundary)', () => {
  @Component({
    standalone: true,
    imports: [TrackRowComponent, TvNavGroupDirective],
    template: `
      <div appTvNavGroup axis="vertical">
        <app-track-row />
        <app-track-row />
      </div>
    `,
  })
  class HostComponent {}

  function setupHost() {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    // Signal inputs must be written before the first detectChanges (the raw
    // write bypasses signalSetFn, so anything that already read stays stale).
    const rows = fixture.debugElement
      .queryAll(By.directive(TrackRowComponent))
      .map((d) => d.componentInstance as TrackRowComponent);
    expect(rows.length).toBe(2);
    setInputValue(rows[0]!.track, ROW_TRACK);
    setInputValue(rows[1]!.track, OTHER_TRACK);
    rows.forEach((r) => setInputValue(r.showCover, false));
    rows.forEach((r) => setInputValue(r.actions, [{ label: 'Play next', action: () => {} }]));
    fixture.detectChanges();
    const titles: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="track-row-title"]'),
    );
    const q = (sel: string): HTMLButtonElement[] =>
      Array.from(fixture.nativeElement.querySelectorAll(sel));
    return { fixture, titles, q };
  }

  function keydown(el: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  }

  it('the group finds the rows own items: first row title is in the Tab order', () => {
    const { titles } = setupHost();
    expect(titles.length).toBe(2);
    // Before the DI-registration fix, `items()` was empty, so EVERY title
    // resolved to tabindex -1 (indexOf === -1 never equals activeIndex 0).
    expect(titles[0]!.getAttribute('tabindex')).toBe('0');
    expect(titles[1]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown moves focus from the first row title to the second', () => {
    const { fixture, titles } = setupHost();
    titles[0]!.focus();
    const event = keydown(titles[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(titles[1]);
    expect(event.defaultPrevented).toBe(true);
    expect(titles[1]!.getAttribute('tabindex')).toBe('0');
    expect(titles[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowUp moves focus back to the first row title', () => {
    const { fixture, titles } = setupHost();
    titles[1]!.focus();
    fixture.detectChanges();
    keydown(titles[1]!, 'ArrowUp');
    fixture.detectChanges();
    expect(document.activeElement).toBe(titles[0]);
  });

  it('each row is a horizontal child group: ArrowRight walks title -> like -> menu toggle (issue #389)', () => {
    const { fixture, titles, q } = setupHost();
    titles[0]!.focus();
    const event = keydown(titles[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(q('[data-testid="track-like"]')[0]);
    expect(event.defaultPrevented).toBe(true);
    keydown(document.activeElement as HTMLElement, 'ArrowRight');
    fixture.detectChanges();
    expect(document.activeElement).toBe(q('[data-testid="track-row-menu-toggle"]')[0]);
  });

  it('ArrowDown from a row extra lands on the next row (rows stay the vertical unit)', () => {
    const { fixture, titles, q } = setupHost();
    titles[0]!.focus();
    keydown(titles[0]!, 'ArrowRight');
    fixture.detectChanges();
    keydown(q('[data-testid="track-like"]')[0]!, 'ArrowDown');
    fixture.detectChanges();
    expect(document.activeElement).toBe(titles[1]);
  });

  it('a destroyed row unregisters itself from the group', () => {
    const { fixture, titles } = setupHost();
    const group = fixture.debugElement
      .query(By.directive(TvNavGroupDirective))
      .injector.get(TvNavGroupDirective);
    // Since issue #389 each row is its own horizontal child group, so the
    // outer list group holds child groups rather than direct items.
    expect(group.childGroups().length).toBe(2);
    expect(group.items().length).toBe(0);
    expect(titles.length).toBe(2);
    fixture.destroy();
    expect(group.childGroups().length).toBe(0);
  });
});
