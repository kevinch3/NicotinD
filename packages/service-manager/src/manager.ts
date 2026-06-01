import { createLogger } from '@nicotind/core';
import type { NicotinDConfig } from '@nicotind/core';
import type { IServiceStrategy, ServiceHandle, ServiceDefinition } from './strategies/strategy.js';
import { waitForHealthy } from './health.js';
import { buildSlskdDefinition } from './services/slskd.js';
import { buildNavidromeDefinition } from './services/navidrome.js';
import { buildLidarrDefinition } from './services/lidarr.js';

const log = createLogger('service-manager');

// Navidrome occasionally exits early (observed: code 2) on the first start or
// two after an unclean shutdown — a stale lock / port-bind race — then comes up
// cleanly. Retry the start a few times in-process so a fresh boot doesn't fail
// the whole NicotinD process (which previously meant ~90s of unavailability
// while the supervisor restarted everything).
const NAVIDROME_START_ATTEMPTS = 3;
const START_RETRY_BACKOFF_MS = 3_000;

export class ServiceManager {
  private handles = new Map<string, ServiceHandle>();
  private strategy: IServiceStrategy;
  private config: NicotinDConfig;

  constructor(strategy: IServiceStrategy, config: NicotinDConfig) {
    this.strategy = strategy;
    this.config = config;
  }

  async startAll(): Promise<void> {
    await this.startSlskd();
    await this.startNavidrome();
  }

  async startSlskd(): Promise<void> {
    if (this.config.mode === 'external') {
      log.info('External mode — skipping slskd startup');
      return;
    }

    const definition = buildSlskdDefinition(this.config);
    const handle = await this.strategy.start(definition);
    this.handles.set('slskd', handle);

    const healthy = await waitForHealthy(definition.healthCheckUrl, definition.healthCheckTimeoutMs);
    if (!healthy) {
      throw new Error('slskd failed to start within timeout');
    }
  }

  async startNavidrome(): Promise<void> {
    if (this.config.mode === 'external') {
      log.info('External mode — skipping Navidrome startup');
      return;
    }

    const definition = buildNavidromeDefinition(this.config);
    const healthy = await this.startWithRetry('navidrome', definition, NAVIDROME_START_ATTEMPTS);
    if (!healthy) {
      throw new Error('Navidrome failed to start within timeout');
    }
  }

  /**
   * Start a service and wait for health, retrying a bounded number of times. On
   * an unhealthy attempt the dead process is stopped first (freeing any held
   * port/lock) before the next try. Returns true once healthy, false if all
   * attempts are exhausted.
   */
  private async startWithRetry(
    name: string,
    definition: ServiceDefinition,
    attempts: number,
    // Seams for deterministic testing; production uses the real health check.
    opts: {
      healthCheck?: (url: string, timeoutMs: number) => Promise<boolean>;
      backoffMs?: number;
    } = {},
  ): Promise<boolean> {
    const healthCheck = opts.healthCheck ?? waitForHealthy;
    const backoffMs = opts.backoffMs ?? START_RETRY_BACKOFF_MS;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const handle = await this.strategy.start(definition);
      this.handles.set(name, handle);

      const healthy = await healthCheck(definition.healthCheckUrl, definition.healthCheckTimeoutMs);
      if (healthy) return true;

      log.warn({ name, attempt, attempts }, 'Service unhealthy after start; stopping and retrying');
      await this.strategy.stop(handle).catch(() => {});
      this.handles.delete(name);
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    return false;
  }

  async startLidarr(apiKey: string): Promise<void> {
    if (this.config.mode === 'external') {
      log.info('External mode — skipping Lidarr startup');
      return;
    }
    if (!this.config.lidarr) {
      log.info('Lidarr not configured — skipping startup');
      return;
    }

    const definition = buildLidarrDefinition(this.config, apiKey);
    const handle = await this.strategy.start(definition);
    this.handles.set('lidarr', handle);

    const healthy = await waitForHealthy(definition.healthCheckUrl, definition.healthCheckTimeoutMs);
    if (!healthy) {
      log.warn('Lidarr failed to start within timeout — discography features unavailable');
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, handle] of this.handles) {
      log.info({ name }, 'Stopping service');
      await this.strategy.stop(handle);
    }
    this.handles.clear();
  }

  async isHealthy(name: string): Promise<boolean> {
    const handle = this.handles.get(name);
    if (!handle) return this.config.mode === 'external';
    return this.strategy.isRunning(handle);
  }

  async getLogs(name: string, lines?: number): Promise<string[]> {
    const handle = this.handles.get(name);
    if (!handle) return [];
    return this.strategy.getLogs(handle, lines);
  }

  updateConfig(config: NicotinDConfig): void {
    this.config = config;
  }

  hasService(name: string): boolean {
    return this.handles.has(name);
  }

  async restartService(name: string): Promise<void> {
    const handle = this.handles.get(name);
    if (!handle) return;

    const definition =
      name === 'slskd'
        ? buildSlskdDefinition(this.config)
        : name === 'lidarr' && this.config.lidarr
          ? buildLidarrDefinition(this.config, this.config.lidarr.apiKey)
          : buildNavidromeDefinition(this.config);

    const newHandle = await this.strategy.restart(handle, definition);
    this.handles.set(name, newHandle);

    await waitForHealthy(definition.healthCheckUrl, definition.healthCheckTimeoutMs);
  }
}
