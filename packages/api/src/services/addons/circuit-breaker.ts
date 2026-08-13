import type { AddonCallOutcome } from './client.js';

export interface AddonCircuitBreakerOptions {
  /** Contract violations (since the last clean call) that trip the breaker. */
  threshold?: number;
  /** Invoked once when an addon trips — wire to `registry.disable`. */
  onTrip: (addonId: string, reason: string) => void;
}

/**
 * Distinguishes a misbehaving addon from a flaky one (§4). Only **contract
 * violations** (bad shape / oversize / non-JSON — the addon's fault) count; a
 * transient failure (timeout / 5xx) is neutral and never trips or resets. A
 * genuine clean call resets the streak, so an addon that mostly works is never
 * disabled for the occasional glitch. Reaching the threshold trips **once** and
 * calls `onTrip` (which disables the addon with a stated reason); further calls
 * on a tripped addon are ignored until it is re-enabled.
 */
export class AddonCircuitBreaker {
  private violations = new Map<string, number>();
  private tripped = new Set<string>();
  private readonly threshold: number;

  constructor(private readonly opts: AddonCircuitBreakerOptions) {
    this.threshold = opts.threshold ?? 5;
  }

  record(addonId: string, outcome: AddonCallOutcome): void {
    if (this.tripped.has(addonId)) return;

    if (outcome === 'ok') {
      this.violations.delete(addonId);
      return;
    }
    if (outcome === 'transient') return; // not the addon's fault — neutral

    const next = (this.violations.get(addonId) ?? 0) + 1;
    if (next >= this.threshold) {
      this.tripped.add(addonId);
      this.violations.delete(addonId);
      this.opts.onTrip(addonId, `disabled after ${next} protocol contract violations`);
      return;
    }
    this.violations.set(addonId, next);
  }

  /** Clear state for an addon (call when it is re-enabled / removed). */
  reset(addonId: string): void {
    this.violations.delete(addonId);
    this.tripped.delete(addonId);
  }

  isTripped(addonId: string): boolean {
    return this.tripped.has(addonId);
  }
}
