/**
 * PullToRefreshService — the seam between the layout-hosted pull gesture and
 * whatever page is on screen. Pages register what "refresh" means for them
 * (a stack: last registered wins, auto-unregistered when the registrant is
 * destroyed — which gives route scoping for free, since navigating away
 * destroys the page component). The layout gesture calls trigger().
 */
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';

const REFRESH_TIMEOUT_MS = 15_000;
const MIN_REFRESH_VISIBLE_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

@Injectable({ providedIn: 'root' })
export class PullToRefreshService {
  private handlers: Array<() => Promise<void> | void> = [];
  private readonly handlerCount = signal(0);

  readonly refreshing = signal(false);
  readonly hasHandler = computed(() => this.handlerCount() > 0);

  /** Must be called in an injection context (component field/constructor).
   *  Identity-spliced on the registrant's destroy — destroy order across
   *  routes isn't LIFO, so this is not a pop. */
  register(handler: () => Promise<void> | void): void {
    this.handlers.push(handler);
    this.handlerCount.set(this.handlers.length);
    inject(DestroyRef).onDestroy(() => {
      const i = this.handlers.indexOf(handler);
      if (i !== -1) this.handlers.splice(i, 1);
      this.handlerCount.set(this.handlers.length);
    });
  }

  /** Runs the top-of-stack handler. Errors are swallowed (a failed refresh
   *  must never strand the spinner); hung handlers are abandoned at 15s;
   *  refreshing() stays true ≥400ms so the spinner is perceivable. */
  async trigger(): Promise<void> {
    if (this.refreshing()) return;
    const handler = this.handlers[this.handlers.length - 1];
    if (!handler) return;
    this.refreshing.set(true);
    const started = Date.now();
    try {
      await Promise.race([Promise.resolve(handler()), wait(REFRESH_TIMEOUT_MS)]);
    } catch {
      // swallowed — the page's own error surfaces (toasts) own reporting
    } finally {
      const remaining = MIN_REFRESH_VISIBLE_MS - (Date.now() - started);
      if (remaining > 0) await wait(remaining);
      this.refreshing.set(false);
    }
  }
}
