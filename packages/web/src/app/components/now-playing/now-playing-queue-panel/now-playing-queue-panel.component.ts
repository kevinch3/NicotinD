import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  output,
  signal,
} from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { RemotePlaybackService } from '../../../services/remote-playback.service';
import { AuthService } from '../../../services/auth.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../../artist-links/artist-links.component';
import { EntityLinkComponent } from '../../entity-link/entity-link.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { createRowGesture, reorderTargetIndex } from '../../../lib/row-gesture';
import { shouldCommit } from '../../../lib/vertical-swipe';
import { isCoarsePointer } from '../../../lib/platform';

/** Leftward travel that removes a row without a flick. */
export const QUEUE_SWIPE_REMOVE_PX = 96;
/** How long the removal toast offers Undo. */
export const QUEUE_UNDO_SECONDS = 5;
/** Band at the list's top/bottom edge where a lifted row scrolls the list. */
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_STEP_PX = 8;

@Component({
  selector: 'app-now-playing-queue-panel',
  imports: [
    CoverArtComponent,
    ArtistLinksComponent,
    EntityLinkComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-queue-panel.component.html',
})
export class NowPlayingQueuePanelComponent {
  readonly player = inject(PlayerService);
  /** While casting, the list below is the session's queue (#895): edits here
   *  go through `PlayerService` as always and the session forwards them. */
  readonly remote = inject(RemotePlaybackService);
  readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** An artist/album link in a row was followed — the sheet should collapse. */
  readonly linkFollowed = output<void>();

  /** HTML5 drag is the mouse path; a touch screen reorders by long-press. */
  readonly mouseDrag = !isCoarsePointer();

  readonly dragSourceIndex = signal<number | null>(null);
  readonly dropTargetIndex = signal<number | null>(null);

  /** The row under the active touch/pointer gesture. */
  private gestureIndex: number | null = null;
  readonly swipeIndex = signal<number | null>(null);
  readonly swipeDx = signal(0);
  readonly liftIndex = signal<number | null>(null);
  readonly liftDy = signal(0);
  readonly liftTarget = signal<number | null>(null);
  private liftMids: number[] = [];
  private liftHeight = 0;
  private liftFingerDy = 0;
  private liftClientY = 0;
  private liftScrollStart = 0;
  private autoscrollFrame: number | null = null;

  private readonly rowGesture = createRowGesture({
    onSwipeMove: (dx) => {
      this.swipeIndex.set(this.gestureIndex);
      // Leftward only; a rightward drag stays put.
      this.swipeDx.set(Math.min(0, dx));
    },
    onSwipeEnd: ({ dx, velocity, cancelled }) => {
      const index = this.gestureIndex;
      this.gestureIndex = null;
      this.swipeIndex.set(null);
      this.swipeDx.set(0);
      this.swallowNextClick();
      if (cancelled || index === null) return;
      if (shouldCommit(-dx, -velocity, { thresholdPx: QUEUE_SWIPE_REMOVE_PX })) {
        this.removeWithUndo(index);
      }
    },
    onReorderStart: () => this.beginLift(),
    onReorderMove: (dy, e) => {
      this.liftFingerDy = dy;
      this.liftClientY = e.clientY;
      this.updateLift();
      this.ensureAutoscroll();
    },
    onReorderEnd: ({ cancelled }) => {
      const from = this.liftIndex();
      const to = this.liftTarget();
      this.endLift();
      this.swallowNextClick();
      if (!cancelled && from !== null && to !== null) this.reorder(from, to);
    },
  });

  jumpToTrack(index: number): void {
    if (this.dragSourceIndex() !== null) return;
    this.player.jumpToQueueIndex(index);
  }

  clearQueue(): void {
    this.player.clearQueue();
  }

  removeFromQueue(index: number): void {
    this.player.removeFromQueue(index);
  }

  /** The one reorder path: HTML5 drop, touch lift and the handle's arrow keys. */
  reorder(from: number, to: number): void {
    if (from === to || to < 0 || to >= this.player.queue().length) return;
    this.player.moveInQueue(from, to);
  }

  /** Remove through the same PlayerService mutation, with an Undo that puts
   *  the track back at the index it left. */
  removeWithUndo(index: number): void {
    const track = this.player.queue()[index];
    if (!track) return;
    this.player.removeFromQueue(index);
    const id = this.toast.show({
      message: this.i18n.t('nowPlaying.removedFromQueue', { title: track.title }),
      kind: 'info',
      duration: QUEUE_UNDO_SECONDS,
      actions: [
        {
          label: this.i18n.t('nowPlaying.undo'),
          callback: () => {
            this.player.insertInQueue(index, track);
            this.toast.dismiss(id);
          },
        },
      ],
    });
  }

  onRowPointerDown(event: PointerEvent, index: number): void {
    // The mouse reorders through HTML5 drag on the handle.
    if (
      event.pointerType === 'mouse' &&
      event.target instanceof Element &&
      event.target.closest('[data-queue-handle]')
    ) {
      return;
    }
    if (this.rowGesture.mode() !== 'idle') return;
    this.gestureIndex = index;
    this.rowGesture.start(event);
  }

  /** A long-press would open the OS context menu under the lifted row. */
  onRowContextMenu(event: Event): void {
    if (this.rowGesture.mode() !== 'idle') event.preventDefault();
  }

  onHandleKeydown(event: KeyboardEvent, index: number): void {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
    if (to === null) return;
    // Ours, not the list's roving-focus group nor a global shortcut.
    event.preventDefault();
    event.stopPropagation();
    if (to < 0 || to >= this.player.queue().length) return;
    this.reorder(index, to);
    afterNextRender(() => this.handleAt(to)?.focus(), { injector: this.injector });
  }

  /** Where a row sits while a lifted row passes over it. */
  rowTransform(index: number): string | null {
    const from = this.liftIndex();
    if (from === null) return null;
    if (index === from) return `translateY(${this.liftDy()}px) scale(1.02)`;
    const to = this.liftTarget() ?? from;
    if (from < to && index > from && index <= to) return `translateY(${-this.liftHeight}px)`;
    if (to < from && index >= to && index < from) return `translateY(${this.liftHeight}px)`;
    return null;
  }

  swipeTransform(index: number): string | null {
    return this.swipeIndex() === index ? `translateX(${this.swipeDx()}px)` : null;
  }

  onQueueDragStart(event: DragEvent, index: number): void {
    this.dragSourceIndex.set(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      const row = (event.target as Element | null)?.closest('[data-testid="queue-item"]');
      if (row && typeof event.dataTransfer.setDragImage === 'function') {
        event.dataTransfer.setDragImage(row, 16, 16);
      }
    }
  }

  /** Only the handle starts an HTML5 drag — a native link/image drag from a
   *  row would cancel a mouse swipe mid-gesture. */
  onRowDragStart(event: DragEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-queue-handle]')) return;
    event.preventDefault();
  }

  onQueueDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    if (this.dragSourceIndex() !== null) this.dropTargetIndex.set(index);
  }

  onQueueDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    const from = this.dragSourceIndex();
    this.dragSourceIndex.set(null);
    this.dropTargetIndex.set(null);
    if (from !== null) this.reorder(from, index);
  }

  onQueueDragEnd(): void {
    this.dragSourceIndex.set(null);
    this.dropTargetIndex.set(null);
  }

  private list(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(
      '[data-testid="now-playing-queue-list"]',
    );
  }

  private handleAt(index: number): HTMLElement | null {
    return (
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-queue-handle]')[index] ?? null
    );
  }

  private beginLift(): void {
    const from = this.gestureIndex;
    if (from === null) return;
    const rows = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-testid="queue-item"]'),
    );
    const rects = rows.map((row) => row.getBoundingClientRect());
    this.liftMids = rects.map((r) => r.top + r.height / 2);
    this.liftHeight = rects[from]?.height ?? 0;
    this.liftFingerDy = 0;
    this.liftScrollStart = this.list()?.scrollTop ?? 0;
    this.liftIndex.set(from);
    this.liftDy.set(0);
    this.liftTarget.set(from);
  }

  /** Finger travel plus however far the list scrolled under it. */
  private updateLift(): void {
    const from = this.liftIndex();
    if (from === null) return;
    const scrolled = (this.list()?.scrollTop ?? 0) - this.liftScrollStart;
    const dy = this.liftFingerDy + scrolled;
    this.liftDy.set(dy);
    this.liftTarget.set(reorderTargetIndex(this.liftMids, from, dy));
  }

  private ensureAutoscroll(): void {
    if (this.autoscrollFrame !== null || typeof requestAnimationFrame !== 'function') return;
    const step = (): void => {
      this.autoscrollFrame = null;
      const list = this.list();
      if (this.liftIndex() === null || !list) return;
      const rect = list.getBoundingClientRect();
      let delta = 0;
      if (this.liftClientY < rect.top + AUTOSCROLL_EDGE_PX) delta = -AUTOSCROLL_STEP_PX;
      else if (this.liftClientY > rect.bottom - AUTOSCROLL_EDGE_PX) delta = AUTOSCROLL_STEP_PX;
      if (delta === 0) return;
      const before = list.scrollTop;
      list.scrollTop = before + delta;
      if (list.scrollTop === before) return;
      this.updateLift();
      this.autoscrollFrame = requestAnimationFrame(step);
    };
    this.autoscrollFrame = requestAnimationFrame(step);
  }

  private endLift(): void {
    if (this.autoscrollFrame !== null) cancelAnimationFrame(this.autoscrollFrame);
    this.autoscrollFrame = null;
    this.gestureIndex = null;
    this.liftIndex.set(null);
    this.liftTarget.set(null);
    this.liftDy.set(0);
  }

  /** A gesture that ends over the title button or a link must not also jump
   *  or navigate: swallow the click its pointerup may synthesize. */
  private swallowNextClick(): void {
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }));
  }
}
