import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { NowPlayingCoverArtComponent } from './now-playing-cover-art.component';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { LikeService } from '../../../services/like.service';
import { ReportTrackService } from '../../../services/report-track.service';
import { SongMenuService } from '../../../services/song-menu.service';
import { setInputValue } from '../../../../testing/signal-input';
import { HOLD_MS, HOLD_SLOP_PX } from '../../../directives/entity-actions.directive';
import { provideRouter } from '@angular/router';
import { TranslateService, interpolate } from '../../../services/translate.service';
import EN from '../../../../../public/i18n/en.json';

describe('NowPlayingCoverArtComponent', () => {
  const track = {
    id: 't1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    albumId: 'al1',
    bitRate: 320,
  };
  let likes: { isLiked: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> };
  let report: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    likes = { isLiked: vi.fn().mockReturnValue(false), toggle: vi.fn() };
    report = { open: vi.fn(), close: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: PlayerService,
          useValue: {
            currentTrack: () => track,
            nextNeighbour: () => null,
            prevNeighbour: () => null,
          },
        },
        { provide: AuthService, useValue: { token: () => 'tok', mediaToken: () => 'tok' } },
        { provide: LikeService, useValue: likes },
        { provide: ReportTrackService, useValue: report },
        {
          provide: SongMenuService,
          useValue: { build: () => [{ label: 'Song info', action: vi.fn() }] },
        },
      ],
    });
  });

  it('spends no line on the bitrate — it lives in Track info (#1661)', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    setInputValue(fixture.componentInstance.coverMaxPx, 320);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="now-playing-album"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="now-playing-quality"]')).toBeNull();
    expect(el.textContent).not.toContain('kbps');
  });

  it('has no standalone lyrics-toggle button (superseded by the panel tabs)', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-toggle"]'),
    ).toBeNull();
  });

  it('the title stands alone on a phone: no like, flag or info beside it (#1716)', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    fixture.detectChanges();
    const row: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-title-row"]',
    );
    expect(row).toBeTruthy();
    // Like leads the transport row (layout B); Info and Report are ⋯ items.
    expect(row.querySelector('[data-testid="now-playing-like"]')).toBeNull();
    expect(row.querySelector('[data-testid="now-playing-report"]')).toBeNull();
    expect(row.querySelector('[data-testid="now-playing-info"]')).toBeNull();
    expect(row.querySelector('button')).toBeNull();
  });

  it('hides the like heart on TV (root nav group has no room for a fourth stop)', () => {
    document.documentElement.classList.add('tv-build');
    try {
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="now-playing-like"]')).toBeNull();
    } finally {
      document.documentElement.classList.remove('tv-build');
    }
  });

  it('the ⋯ sits on the artwork and lists the shared song menu (#1716)', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const toggle = el.querySelector('[data-testid="now-playing-menu-toggle"]')!;
    expect(toggle).toBeTruthy();
    expect(toggle.closest('[data-testid="now-playing-cover"]')).not.toBeNull();
    expect(toggle.closest('[data-testid="now-playing-title-row"]')).toBeNull();
    // Info and Report reach the listener through the shared SongMenuService list.
    expect(fixture.componentInstance.menuActions().map((a) => a.label)).toEqual(['Song info']);
  });

  describe('long-press on the artwork (#1716)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      // A fired hold arms a one-click swallow on window until the next press.
      window.dispatchEvent(new Event('pointerdown'));
    });

    function press(
      fixture: ReturnType<typeof TestBed.createComponent<NowPlayingCoverArtComponent>>,
      init: { pointerType?: string; target?: Element } = {},
    ): void {
      const stage = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-cover-stage"]',
      ) as HTMLElement;
      fixture.componentInstance.onCoverPointerDown({
        pointerType: init.pointerType ?? 'touch',
        isPrimary: true,
        clientX: 100,
        clientY: 100,
        target: init.target ?? stage,
      } as unknown as PointerEvent);
    }
    // Signal viewChild does not resolve under the JIT harness (docs/web-ui.md),
    // so the hold is asserted at the component's own seam; e2e drives the DOM.
    let opened: ReturnType<typeof vi.fn>;
    const menuOpen = () => opened.mock.calls.length > 0;
    function create() {
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      fixture.detectChanges();
      opened = vi.fn();
      (fixture.componentInstance as unknown as { openMenu: () => void }).openMenu = opened;
      return fixture;
    }

    it('a still hold opens the track menu', () => {
      const fixture = create();
      press(fixture);
      vi.advanceTimersByTime(HOLD_MS - 1);
      expect(menuOpen()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(menuOpen()).toBe(true);
    });

    it('a hold that travels past the slop is a swipe, never a menu', () => {
      const fixture = create();
      press(fixture);
      document.dispatchEvent(
        Object.assign(new Event('pointermove'), { clientX: 100 + HOLD_SLOP_PX, clientY: 100 }),
      );
      vi.advanceTimersByTime(HOLD_MS * 2);
      expect(menuOpen()).toBe(false);
    });

    it('a mouse press starts no hold (a mouse has right-click)', () => {
      const fixture = create();
      press(fixture, { pointerType: 'mouse' });
      vi.advanceTimersByTime(HOLD_MS * 2);
      expect(menuOpen()).toBe(false);
    });

    it('a press on a control belongs to the control', () => {
      const fixture = create();
      const toggle = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-menu-toggle"]',
      ) as HTMLElement;
      press(fixture, { target: toggle });
      vi.advanceTimersByTime(HOLD_MS * 2);
      expect(menuOpen()).toBe(false);
    });
  });

  it('hides the flag and the ⋯ menu on TV, like the like heart', () => {
    // Same reason as the heart: TvNavGroupDirective orders by DOM position, so
    // a new nav item here shifts the sheet's pinned ArrowUp chain.
    document.documentElement.classList.add('tv-build');
    try {
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="now-playing-report"]')).toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="now-playing-menu-toggle"]'),
      ).toBeNull();
    } finally {
      document.documentElement.classList.remove('tv-build');
    }
  });

  it('renders the album under the artist line as an entity link', () => {
    // The nested component's inputs and outputs do not land in the JIT harness
    // (src/testing/signal-input.ts), so the href and the close-on-follow are
    // exercised end to end in e2e/tests/entity-links.spec.ts.
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    fixture.detectChanges();
    const line: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-album"]',
    );
    expect(line).not.toBeNull();
    expect(line.querySelector('app-entity-link')).not.toBeNull();
  });

  it('omits the album line on TV (the root nav group order is pinned)', () => {
    document.documentElement.classList.add('tv-build');
    try {
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="now-playing-album"]')).toBeNull();
    } finally {
      document.documentElement.classList.remove('tv-build');
    }
  });

  it('publishes coverMaxPx as the --np-cover-max var, not an inline max-width', () => {
    // An inline style.max-width would beat every class — including the lg:
    // side-panel layout's fixed cap — so the mobile queue-resize shrink rides a
    // CSS var that lg:max-w-80 can override via the responsive cascade.
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    setInputValue(fixture.componentInstance.coverMaxPx, 240);
    fixture.detectChanges();
    const cover: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-cover"]',
    );
    expect(cover.style.getPropertyValue('--np-cover-max')).toBe('240px');
    expect(cover.style.maxWidth).toBe('');
  });

  // #1652: a ±1 carousel at rest. Which track each side is comes from
  // PlayerService.nextNeighbour/prevNeighbour, pinned against playNext/playPrev
  // in player.service.spec.ts; this pins what the sheet does with them.
  describe('neighbour carousel (#1652)', () => {
    const next = { id: 'n', title: 'Upcoming Song', artist: 'B', coverArt: 'cn' };
    const prev = { id: 'p', title: 'Earlier Song', artist: 'C', coverArt: 'cp' };
    function render(
      offset: number,
      neighbours: { next?: unknown; prev?: unknown } = { next, prev },
    ) {
      TestBed.overrideProvider(PlayerService, {
        useValue: {
          currentTrack: () => track,
          nextNeighbour: () => neighbours.next ?? null,
          prevNeighbour: () => neighbours.prev ?? null,
        },
      });
      const catalog = EN as Record<string, string>;
      TestBed.overrideProvider(TranslateService, {
        useValue: {
          t: (k: string, p?: Record<string, string | number>) => interpolate(catalog[k] ?? k, p),
          lang: () => 'en',
          revision: () => 0,
        },
      });
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      setInputValue(fixture.componentInstance.swipeOffsetPx, offset);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const slider = q('now-playing-cover-stage')!.firstElementChild as HTMLElement;
      return {
        fixture,
        slider,
        nextEl: q('now-playing-cover-next'),
        prevEl: q('now-playing-cover-prev'),
      };
    }

    it('shows both neighbours at rest, dimmed and scaled toward the cover', () => {
      const { slider, nextEl, prevEl } = render(0);
      expect(slider.style.transform).toBe('');
      expect(nextEl).not.toBeNull();
      expect(prevEl).not.toBeNull();
      expect(nextEl!.className).toContain('left-[calc(100%+1rem)]');
      expect(prevEl!.className).toContain('right-[calc(100%+1rem)]');
      for (const side of [nextEl!, prevEl!]) {
        expect(side.style.opacity).toBe('0.5');
        expect(side.style.scale).toBe('0.85');
      }
    });

    it('names the track each neighbour skips to', () => {
      const { nextEl, prevEl } = render(0);
      expect(nextEl!.getAttribute('aria-label')).toBe('Skip to the next track, Upcoming Song');
      expect(prevEl!.getAttribute('aria-label')).toBe('Back to the previous track, Earlier Song');
    });

    it('tapping a neighbour asks the sheet to skip that way', () => {
      const { fixture, nextEl, prevEl } = render(0);
      const skips: string[] = [];
      fixture.componentInstance.skipRequested.subscribe((d) => skips.push(d));
      nextEl!.click();
      prevEl!.click();
      expect(skips).toEqual(['next', 'prev']);
    });

    it('marks each neighbour as a sliver, so a drag from it is a drag of the cover', () => {
      const { nextEl, prevEl } = render(0);
      expect(nextEl!.hasAttribute('data-np-sliver')).toBe(true);
      expect(prevEl!.hasAttribute('data-np-sliver')).toBe(true);
    });

    it('renders no neighbour while showNeighbours is off (controlling another device)', () => {
      TestBed.overrideProvider(PlayerService, {
        useValue: {
          currentTrack: () => track,
          nextNeighbour: () => next,
          prevNeighbour: () => prev,
        },
      });
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      setInputValue(fixture.componentInstance.showNeighbours, false);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="now-playing-cover-next"]')).toBeNull();
      expect(el.querySelector('[data-testid="now-playing-cover-prev"]')).toBeNull();
    });

    it('renders no neighbour (and no tap target) where a skip lands nowhere', () => {
      const { nextEl, prevEl } = render(0, {});
      expect(nextEl).toBeNull();
      expect(prevEl).toBeNull();
    });

    it('a leftward drag slides the strip and brings the next cover up to full size', () => {
      const { slider, nextEl, prevEl } = render(-60);
      expect(slider.style.transform).toBe('translateX(-60px)');
      expect(nextEl!.style.opacity).toBe('');
      expect(nextEl!.style.scale).toBe('');
      expect(prevEl!.style.opacity).toBe('0.5');
    });

    it('a rightward drag brings the previous cover up instead', () => {
      const { prevEl, nextEl } = render(60);
      expect(prevEl!.style.opacity).toBe('');
      expect(nextEl!.style.opacity).toBe('0.5');
    });

    it('keeps the neighbours off TV (the root nav group order is pinned)', () => {
      document.documentElement.classList.add('tv-build');
      try {
        const { nextEl, prevEl } = render(0);
        expect(nextEl).toBeNull();
        expect(prevEl).toBeNull();
      } finally {
        document.documentElement.classList.remove('tv-build');
      }
    });
  });

  // #1655: each credit must open its OWN artist. The link navigates via its own
  // routerLink, so a followed credit may only report artistLinkFollowed (the sheet
  // closes) — never the artist-agnostic navigateToArtistClicked, whose handler
  // re-navigated to the primary artist and won. The nested links' DOM is not
  // rendered under the JIT harness (docs/web-ui.md), so the clicks themselves are
  // pinned in e2e/tests/now-playing-artist-links.spec.ts.
  describe('artist credits (#1655)', () => {
    afterEach(() => delete (track as { artists?: unknown }).artists);

    function render(artists?: unknown[]) {
      if (artists) Object.assign(track, { artists });
      const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
      const followed = vi.fn();
      const generic = vi.fn();
      fixture.componentInstance.artistLinkFollowed.subscribe(followed);
      fixture.componentInstance.navigateToArtistClicked.subscribe(generic);
      fixture.detectChanges();
      return { fixture, followed, generic };
    }

    it('a followed credit link reports artistLinkFollowed, not the generic navigation', () => {
      const { fixture, followed, generic } = render([
        { id: 'a1', name: 'First', role: 'primary' },
        { id: 'a2', name: 'Second', role: 'primary' },
      ]);
      const links = fixture.debugElement.query((d) => d.name === 'app-artist-links');
      expect(links).toBeTruthy();
      links.triggerEventHandler('linkFollowed');
      expect(followed).toHaveBeenCalledTimes(1);
      expect(generic).not.toHaveBeenCalled();
    });

    it('with no credits, the plain-text artist asks the sheet to navigate', () => {
      const { fixture, followed, generic } = render();
      expect(fixture.debugElement.query((d) => d.name === 'app-artist-links')).toBeNull();
      const plain = Array.from(
        fixture.nativeElement.querySelectorAll('span') as NodeListOf<HTMLElement>,
      ).find((s) => s.textContent?.trim() === 'Artist')!;
      plain.click();
      expect(generic).toHaveBeenCalledTimes(1);
      expect(followed).not.toHaveBeenCalled();
    });
  });
});
