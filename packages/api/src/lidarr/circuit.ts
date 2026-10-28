import { createLogger } from '@nicotind/core';

const log = createLogger('lidarr-circuit');

export interface LidarrCircuitOptions {
  /** Consecutive failures (timeout, network, 5xx) that open the breaker. */
  threshold?: number;
  /** First cool-down; each failed probe doubles it, up to `maxCooldownMs`. */
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

/**
 * Back-pressure for Lidarr (issue #1581). While Lidarr was out of memory every
 * background caller kept sending it 10-20 s requests, adding load to the thing
 * that was failing. Every call's outcome feeds this; only *background* calls
 * consult it (`LidarrClient.background()`), so a person's request is never
 * refused — and any answered call, theirs included, closes it.
 *
 * Once open it stays open until something succeeds: after each cool-down
 * exactly one background call is let through as a probe. A failed probe doubles
 * the cool-down. → docs/design-patterns.md "Outbound Lidarr calls are bounded"
 */
export class LidarrCircuit {
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  private failures = 0;
  private tripped = false;
  private cooldownMs = 0;
  private openUntil = 0;
  private probing = false;
  private lastFailure: number | null = null;

  constructor(opts: LidarrCircuitOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.baseCooldownMs = opts.baseCooldownMs ?? 60_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Lidarr is failing: background work should not run. */
  get isOpen(): boolean {
    return this.tripped;
  }

  /** The cool-down is over and no probe is in flight. */
  get probeDue(): boolean {
    return this.tripped && !this.probing && this.now() >= this.openUntil;
  }

  get lastFailureAt(): number | null {
    return this.lastFailure;
  }

  /** May a background call go out now? Takes the probe slot when one is due. */
  admit(): boolean {
    if (!this.tripped) return true;
    if (!this.probeDue) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    if (this.tripped) log.info('Lidarr is answering again — background calls resumed');
    this.failures = 0;
    this.tripped = false;
    this.cooldownMs = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  recordFailure(): void {
    const at = this.now();
    this.lastFailure = at;
    this.failures++;
    this.probing = false;
    if (this.tripped) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.openUntil = at + this.cooldownMs;
      log.warn(
        { cooldownMs: this.cooldownMs },
        'Lidarr probe failed — background calls stay paused',
      );
      return;
    }
    if (this.failures < this.threshold) return;
    this.tripped = true;
    this.cooldownMs = this.baseCooldownMs;
    this.openUntil = at + this.cooldownMs;
    log.warn(
      { failures: this.failures, cooldownMs: this.cooldownMs },
      'Lidarr keeps failing — background calls paused',
    );
  }
}
