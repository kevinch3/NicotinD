/**
 * PageBackService — the seam between the shell's top bar and whatever page is
 * on screen (#1770). A page that has a back target registers what "back" means
 * for it; the bar renders its one back arrow while a registration is live and
 * runs the newest one on tap. Pages never render their own arrow.
 *
 * Same shape as PullToRefreshService: auto-unregistered when the registrant is
 * destroyed, which scopes it to the route for free.
 */
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class PageBackService {
  private handlers: Array<() => void> = [];
  private readonly count = signal(0);

  /** The current page has a back target — the bar shows its arrow. */
  readonly hasTarget = computed(() => this.count() > 0);

  /** Must be called in an injection context (component field/constructor).
   *  Identity-spliced on destroy: route destroy order is not LIFO. */
  register(handler: () => void): void {
    this.handlers.push(handler);
    this.count.set(this.handlers.length);
    inject(DestroyRef).onDestroy(() => {
      const i = this.handlers.indexOf(handler);
      if (i !== -1) this.handlers.splice(i, 1);
      this.count.set(this.handlers.length);
    });
  }

  /** A fixed destination rather than history — what a `routerLink` arrow did.
   *  Same injection-context rule as `register`. */
  registerRoute(commands: unknown[]): void {
    const router = inject(Router);
    this.register(() => void router.navigate(commands));
  }

  /** Runs the newest registration; a no-op when nothing is registered. */
  back(): void {
    this.handlers[this.handlers.length - 1]?.();
  }
}
