import {
  AfterViewInit,
  Directive,
  ElementRef,
  HostAttributeToken,
  OnDestroy,
  inject,
} from '@angular/core';
import { isTvUi } from '../lib/platform';
import { OverflowReveal, browserRevealEnv, type OverflowRevealMode } from '../lib/overflow-reveal';

/**
 * Put on the element that carries `truncate` around a name:
 * `<p class="truncate" appOverflowReveal>{{ track.title }}</p>`, or
 * `appOverflowReveal="always"` for the playing title. The mode is a static
 * attribute, read once — it never changes for a site. Every truncated name in
 * a template must carry it, or sit on the allowlist in
 * `overflow-reveal-policy.spec.ts` (#1665).
 */
@Directive({
  selector: '[appOverflowReveal]',
  standalone: true,
})
export class OverflowRevealDirective implements AfterViewInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly mode: OverflowRevealMode =
    inject(new HostAttributeToken('appOverflowReveal'), { optional: true }) === 'always'
      ? 'always'
      : 'list';
  private reveal: OverflowReveal | null = null;

  ngAfterViewInit(): void {
    this.reveal = new OverflowReveal(this.el.nativeElement, this.mode, browserRevealEnv(isTvUi));
  }

  ngOnDestroy(): void {
    this.reveal?.destroy();
    this.reveal = null;
  }
}
