import { Injectable, signal } from '@angular/core';

export interface ToastAction {
  label: string;
  callback: () => void;
}

export interface ToastConfig {
  message: string;
  kind: 'info' | 'success' | 'error';
  actions?: ToastAction[];
  countdown?: number;
  duration?: number;
}

export interface Toast extends ToastConfig {
  id: string;
}

const MAX_TOASTS = 3;
const TICK_MS = 50;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private countdownPcts = signal<Record<string, number>>({});
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  getCountdownPct(id: string): number {
    return this.countdownPcts()[id] ?? 100;
  }

  show(config: ToastConfig): string {
    const id = crypto.randomUUID();
    let dropped = false;
    this.toasts.update((prev) => {
      const next = [...prev, { ...config, id }];
      if (next.length > MAX_TOASTS) {
        const evictIdx = next.findIndex((t) => !t.countdown);
        if (evictIdx !== -1) {
          const evicted = next[evictIdx];
          this._clearTimer(evicted.id);
          next.splice(evictIdx, 1);
        } else {
          // All active toasts are countdowns — drop the new one rather than exceed the cap.
          next.pop();
          dropped = true;
        }
      }
      return next;
    });

    // The toast was dropped to honour the cap — never arm a timer for it, or its
    // countdown would still fire actions[0] (e.g. an auto-download) for a toast
    // the user never saw.
    if (dropped) return id;

    if (config.countdown) {
      const totalMs = config.countdown * 1000;
      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += TICK_MS;
        const pct = Math.max(0, 100 - (elapsed / totalMs) * 100);
        this.countdownPcts.update((prev) => ({ ...prev, [id]: pct }));
        if (elapsed >= totalMs) {
          this._clearTimer(id);
          config.actions?.[0]?.callback();
          this.dismiss(id);
        }
      }, TICK_MS);
      this.timers.set(id, interval);
    } else {
      const durationMs = (config.duration ?? 4) * 1000;
      const timer = setTimeout(() => {
        this._clearTimer(id);
        this.dismiss(id);
      }, durationMs) as unknown as ReturnType<typeof setInterval>;
      this.timers.set(id, timer);
    }

    return id;
  }

  dismiss(id: string): void {
    this._clearTimer(id);
    this.toasts.update((prev) => prev.filter((t) => t.id !== id));
    this.countdownPcts.update((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  private _clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  reset(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.toasts.set([]);
    this.countdownPcts.set({});
  }
}
