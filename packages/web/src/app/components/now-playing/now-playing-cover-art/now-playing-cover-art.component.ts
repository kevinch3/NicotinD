import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HOLD_MS, HOLD_SLOP_PX } from '../../../directives/entity-actions.directive';
import { haptic } from '../../../lib/haptics';
import { PlayerService, type Track } from '../../../services/player.service';
import { songCover } from '../../../lib/cover-url';
import { CoverRevisionsService } from '../../../services/cover-revisions.service';
import { AuthService } from '../../../services/auth.service';
import { LikeService } from '../../../services/like.service';
import { ReportTrackService } from '../../../services/report-track.service';
import { SongMenuService } from '../../../services/song-menu.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../../artist-links/artist-links.component';
import { EntityLinkComponent } from '../../entity-link/entity-link.component';
import { MenuPanelComponent } from '../../menu-panel/menu-panel.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { isTvUi } from '../../../lib/platform';
import { OverflowRevealDirective } from '../../../directives/overflow-reveal.directive';

/** The width Tailwind's `lg` starts at: the side-panel layout, where the cover
 *  ignores the queue-resize shrink (`lg:max-w-80`). */
const LG_PX = 1024;

/**
 * #1763: how visible the neighbour covers are while the queue resize shrinks
 * the cover. 1 at the cover's rest width (`min(60vw, 20rem)`), fading linearly
 * to 0 by half of it, so they leave the scene instead of shrinking along.
 */
export function neighbourFade(coverMaxPx: number, viewportWidth: number): number {
  if (viewportWidth >= LG_PX) return 1;
  const rest = Math.min(viewportWidth * 0.6, 320);
  if (rest <= 0) return 0;
  const shown = Math.min(coverMaxPx, rest) / rest;
  return Math.max(0, Math.min(1, (shown - 0.5) / 0.5));
}

@Component({
  selector: 'app-now-playing-cover-art',
  imports: [
    NgTemplateOutlet,
    OverflowRevealDirective,
    CoverArtComponent,
    ArtistLinksComponent,
    EntityLinkComponent,
    MenuPanelComponent,
    TranslatePipe,
    TvNavItemDirective,
  ],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents', '(window:resize)': 'onViewportResize()' },
  templateUrl: './now-playing-cover-art.component.html',
})
export class NowPlayingCoverArtComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly likes = inject(LikeService);
  readonly report = inject(ReportTrackService);
  private readonly songMenu = inject(SongMenuService);
  private readonly coverRevisions = inject(CoverRevisionsService);

  /** A track's cover at its album's live cover rev (#1666). */
  coverSrc(track: Track): string | undefined {
    return this.coverRevisions.url(songCover(track), 600, this.auth.mediaToken());
  }

  private readonly menu = viewChild(MenuPanelComponent);

  /** The same list every track row shows — `Track` is `BaseSong` plus an
   *  optional `queuedBy`, so the current track passes straight through. */
  readonly menuActions = computed(() => {
    const track = this.player.currentTrack();
    return track ? this.songMenu.build(track) : [];
  });

  // TV-hidden, mirroring now-playing-transport's shuffle/repeat cut (D-pad
  // economy) — the root nav group's ArrowUp order is a fixed sequence
  // (playpause → track info → next-up chip → close, see
  // now-playing-tv.spec.ts), so inserting another direct item here would
  // shift every step of it. Like stays reachable on TV via the track row /
  // ⋯ menu.
  readonly isTv = isTvUi();

  /** Layout B (#1716): the ⋯ on the artwork and the long-press menu, with no
   *  ⓘ/⚑/♡ beside the title. TV keeps its pinned D-pad chrome. */
  readonly artChrome = !this.isTv;

  readonly coverMaxPx = input<number>(320);
  readonly resizing = input(false);
  /** Live horizontal swipe-to-skip travel (#1297); the cover follows it. */
  readonly swipeOffsetPx = input(0);
  /** True while the finger is down, so the cover tracks it without easing. */
  readonly swiping = input(false);

  /** False while this device controls another: the output's history, repeat
   *  and shuffle are not mirrored here, so a labelled neighbour would promise a
   *  track ⏮/⏭ on the output may not land on. The swipe still sends NEXT/PREV. */
  readonly showNeighbours = input(true);

  /** The carousel's neighbours (#1652): the covers a skip lands on, peeking in
   *  at rest and followed by the swipe. Not on TV (D-pad order, see isTv). */
  readonly nextTrack = computed(() =>
    this.isTv || !this.showNeighbours() ? null : this.player.nextNeighbour(),
  );
  readonly prevTrack = computed(() =>
    this.isTv || !this.showNeighbours() ? null : this.player.prevNeighbour(),
  );

  private readonly viewportWidth = signal(typeof window === 'undefined' ? 0 : window.innerWidth);
  /** Neighbour visibility under the queue-resize shrink (#1763). */
  readonly neighbourFade = computed(() => neighbourFade(this.coverMaxPx(), this.viewportWidth()));
  /** A neighbour's opacity: dimmed at rest, full when a swipe heads for it, times the fade. */
  neighbourOpacity(headedFor: boolean): number {
    return (headedFor ? 1 : 0.5) * this.neighbourFade();
  }
  onViewportResize(): void {
    this.viewportWidth.set(window.innerWidth);
  }

  /** A peeking neighbour was tapped: the sheet skips the way its ⏭/⏮ do. */
  readonly skipRequested = output<'next' | 'prev'>();

  /** Fully dragged away — the wrapper drops its padding so no empty band remains. */
  readonly coverCollapsed = computed(() => this.coverMaxPx() <= 0);

  readonly openTrackInfo = output<string>();
  /** A linked artist name was followed; its own routerLink navigates, so the
   *  sheet only closes (#1655). */
  readonly artistLinkFollowed = output<void>();
  /** The plain-text artist fallback (no `artists` credits) was clicked. */
  readonly navigateToArtistClicked = output<void>();
  /** The album link under the artist line was followed — the sheet should close. */
  readonly navigateToAlbumClicked = output<void>();

  constructor() {
    // A hold the sheet's swipe took over is a swipe, never a menu: the moment
    // the cover starts following the finger the timer is dead (the slop check
    // below catches the dismiss drag, which does not move the cover).
    effect(() => {
      if (this.swipeOffsetPx() !== 0) this.cancelHold();
    });
    inject(DestroyRef).onDestroy(() => this.cancelHold());
  }

  // ── Long-press on the artwork (#1716) ──────────────────────────
  // The Mosaic / EntityActionsDirective contract: HOLD_MS still, HOLD_SLOP_PX
  // of travel cancels, haptic('hold'), touch/pen only (a mouse has right-click),
  // a press on a control (⋯, Like, a neighbour sliver) belongs to the control.
  // Movement is watched on the document, like the sheet's own swipes, so a
  // finger that leaves the cover still cancels.
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdOrigin: { x: number; y: number } | null = null;
  private readonly onHoldMove = (e: PointerEvent): void => {
    if (!this.holdOrigin) return;
    if (
      Math.abs(e.clientX - this.holdOrigin.x) >= HOLD_SLOP_PX ||
      Math.abs(e.clientY - this.holdOrigin.y) >= HOLD_SLOP_PX
    ) {
      this.cancelHold();
    }
  };
  private readonly onHoldEnd = (): void => this.cancelHold();

  onCoverPointerDown(e: PointerEvent): void {
    if (!this.artChrome || e.pointerType === 'mouse' || e.isPrimary === false) return;
    if (
      e.target instanceof Element &&
      e.target.closest('button, a, app-menu-panel, [data-np-sliver]')
    ) {
      return;
    }
    this.cancelHold();
    this.holdOrigin = { x: e.clientX, y: e.clientY };
    document.addEventListener('pointermove', this.onHoldMove);
    document.addEventListener('pointerup', this.onHoldEnd);
    document.addEventListener('pointercancel', this.onHoldEnd);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.cancelHold();
      haptic('hold');
      this.swallowNextClick();
      this.openMenu();
    }, HOLD_MS);
  }

  /** Right-click on the cover (desktop), and the touch contextmenu a long
   *  press fires after the hold already opened the menu — idempotent. */
  onCoverContextMenu(e: MouseEvent): void {
    if (!this.artChrome) return;
    if (e.target instanceof Element && e.target.closest('[data-np-sliver]')) return;
    e.preventDefault();
    this.openMenu();
  }

  cancelHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdOrigin = null;
    document.removeEventListener('pointermove', this.onHoldMove);
    document.removeEventListener('pointerup', this.onHoldEnd);
    document.removeEventListener('pointercancel', this.onHoldEnd);
  }

  /** The release after a hold fires a click — on the common ancestor of the
   *  cover and the panel that opened under the finger — and the menu panel's
   *  document click would close the menu it just opened. Eat that one click. */
  private swallowNextClick(): void {
    const eat = (e: Event): void => {
      e.stopPropagation();
      e.preventDefault();
      disarm();
    };
    // Armed until that click or the next press, whichever comes first — a
    // finger that stays down a while after the menu opens still lifts into it.
    const disarm = (): void => {
      window.removeEventListener('click', eat, { capture: true });
      window.removeEventListener('pointerdown', disarm, { capture: true });
    };
    window.addEventListener('click', eat, { capture: true });
    window.addEventListener('pointerdown', disarm, { capture: true });
  }

  private openMenu(): void {
    const m = this.menu();
    if (m && !m.open()) m.toggle(new Event('hold'));
  }

  closeMenu(): void {
    this.menu()?.close();
  }

  toggleLike(id: string): void {
    void this.likes.toggle(id);
  }

  /** Right-click keeps working, but it now opens the same ⋯ panel the button
   *  does — one menu in the sheet, not two (issue #1038). Anchored to the
   *  trigger rather than the pointer, so the menu lands in one known place. */
  onTitleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (!this.isTv) this.menu()?.toggle(event);
  }
}
