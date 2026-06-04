import { createLogger } from '@nicotind/core';
import type { NicotinDConfig } from '@nicotind/core';
import type { IServiceStrategy, ServiceHandle } from './strategies/strategy.js';
import { waitForHealthy } from './health.js';
import { buildSlskdDefinition } from './services/slskd.js';
import { buildLidarrDefinition } from './services/lidarr.js';

const log = createLogger('service-manager');

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
  }

  async startSlskd(): Promise<void> {
    if (this.config.mode === 'external') {
      log.info('External mode — skipping slskd startup');
      return;
    }

    const definition = buildSlskdDefinition(this.config);
    const handle = await this.strategy.start(definition);
    this.handles.set('slskd', handle);

    const healthy = await waitForHealthy(
      definition.healthCheckUrl,
      definition.healthCheckTimeoutMs,
    );
    if (!healthy) {
      throw new Error('slskd failed to start within timeout');
    }
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

    const healthy = await waitForHealthy(
      definition.healthCheckUrl,
      definition.healthCheckTimeoutMs,
    );
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

    let definition;
    if (name === 'slskd') {
      definition = buildSlskdDefinition(this.config);
    } else if (name === 'lidarr' && this.config.lidarr) {
      definition = buildLidarrDefinition(this.config, this.config.lidarr.apiKey);
    } else {
      return;
    }

    const newHandle = await this.strategy.restart(handle, definition);
    this.handles.set(name, newHandle);

    await waitForHealthy(definition.healthCheckUrl, definition.healthCheckTimeoutMs);
  }
}
