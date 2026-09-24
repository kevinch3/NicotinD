import { Component, Injector, Input, inject } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { isTvUi } from '../../lib/platform';
import { EntityMenuService } from '../../services/entity-menu.service';
import type { TrackAction } from '../track-row/track-row.component';

/**
 * The hover door into a tile's menu (issue #1298): a ⋯ that fades in on the
 * tile's `group-hover` (and on focus, so it is in the tab order for keyboard
 * users) and opens the one entity menu anchored under itself. Safe inside a
 * `<a routerLink>` tile: its click never reaches the link, and its press never
 * starts the tile's hold. Renders nothing on TV, where there is no hover.
 */
@Component({
  selector: 'app-entity-menu-button',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './entity-menu-button.component.html',
  host: { class: 'contents' },
})
export class EntityMenuButtonComponent {
  // Classic `@Input`s: the JIT test harness cannot bind a nested component's
  // signal inputs (src/testing/signal-input.ts), and the tiles bind these.
  @Input() actions: () => TrackAction[] = () => [];
  /** Extra classes for placement (the tile decides the corner). */
  @Input() placement = 'absolute top-2 right-2';

  readonly tv = isTvUi();
  private readonly injector = inject(Injector);
  private get menu(): EntityMenuService {
    return this.injector.get(EntityMenuService);
  }

  onClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.menu.open({ actions: this.actions(), anchor: e.currentTarget as HTMLElement });
  }
}
