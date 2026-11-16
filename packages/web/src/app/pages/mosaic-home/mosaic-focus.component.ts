import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NO_PREVIEW, PREVIEW_COUNT, type FocusPreview } from '../../lib/mosaic-focus';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { BackButtonService } from '../../services/native/back-button.service';

/** How long the face takes to grow out of the tile that was tapped. */
export const FOCUS_GROW_MS = 420;

/**
 * The mosaic tile brought forward by a tap: the only tile that can start
 * anything. Presentational; the mosaic owns what Play, Shuffle and ⋯ do.
 * See docs/mosaic-tile-focus-design.md.
 */
@Component({
  selector: 'app-mosaic-focus',
  standalone: true,
  imports: [OverflowRevealDirective, TranslatePipe],
  templateUrl: './mosaic-focus.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mosaic-focus', 'data-testid': 'mosaic-focus' },
})
export class MosaicFocusComponent {
  // Defaults, never `input.required`: the JIT test harness cannot bind a nested
  // component's signal inputs (testing/signal-input.ts).
  readonly title = input('');
  readonly subtitle = input('');
  /** CSS `background-image` for a cover face; empty for a gradient or plain face. */
  readonly background = input('');
  readonly gradientClass = input('');
  readonly emoji = input('');
  readonly tagKey = input<string | null>(null);
  readonly preview = input<FocusPreview>(NO_PREVIEW);
  readonly side = input(190);
  /** Where the tapped tile sat on screen, so the face can grow out of it. */
  readonly from = input<DOMRect | null>(null);
  readonly busy = input(false);
  readonly hasMenu = input(true);

  readonly play = output<void>();
  readonly shuffle = output<void>();
  readonly more = output<HTMLElement>();
  readonly dismiss = output<void>();

  readonly lead = computed(() => this.preview().tracks.slice(0, PREVIEW_COUNT));
  readonly canShuffle = computed(
    () => this.preview().status === 'ready' && this.preview().tracks.length > PREVIEW_COUNT,
  );
  readonly canPlay = computed(() => !this.busy() && this.preview().status !== 'empty');
  readonly skeletonRows = Array.from({ length: PREVIEW_COUNT }, (_, i) => i);

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  constructor() {
    // Escape and hardware Back both arrive through the shared back stack.
    const unregister = inject(BackButtonService).stack.push(() => {
      this.dismiss.emit();
      return true;
    });
    inject(DestroyRef).onDestroy(unregister);

    afterNextRender(() => {
      this.host.nativeElement
        .querySelector<HTMLElement>('.mosaic-focus-play')
        ?.focus({ preventScroll: true });
      this.growFrom(this.from());
    });
  }

  private growFrom(from: DOMRect | null): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>('.mosaic-focus-face');
    if (!el || !from || typeof el.animate !== 'function') return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    const to = el.getBoundingClientRect();
    if (to.width === 0 || from.width === 0) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` },
        { transform: 'none' },
      ],
      { duration: FOCUS_GROW_MS, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' },
    );
  }
}
