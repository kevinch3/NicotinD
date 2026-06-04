import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type PluginKind = 'acquisition' | 'connectivity';
export type PluginCapability = 'search' | 'browse' | 'resolve' | 'download' | 'connectivity';

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  requirements?: { binaries?: string[] };
  compliance?: { disclaimer: string; requiresConsent: boolean };
  enabled: boolean;
  available: boolean;
  needsConfig: boolean;
}

/**
 * Reads `/api/plugins` and exposes plugin state + the set of capabilities the
 * enabled plugins provide. UI surfaces gate on these computeds so an acquisition
 * feature only shows when a plugin backing it is enabled (the inverse of the
 * compliance default-off posture). Mutations are admin-only on the server.
 */
@Injectable({ providedIn: 'root' })
export class PluginService {
  private http = inject(HttpClient);

  readonly plugins = signal<PluginInfo[]>([]);

  readonly acquisition = computed(() => this.plugins().filter((p) => p.kind === 'acquisition'));
  readonly connectivity = computed(() => this.plugins().filter((p) => p.kind === 'connectivity'));

  /** Capabilities provided by currently-enabled plugins. */
  private readonly enabledCaps = computed(
    () =>
      new Set(
        this.plugins()
          .filter((p) => p.enabled)
          .flatMap((p) => p.capabilities),
      ),
  );

  readonly hasSearch = computed(() => this.enabledCaps().has('search'));
  readonly hasResolve = computed(() => this.enabledCaps().has('resolve'));
  readonly hasDownload = computed(() => this.enabledCaps().has('download'));

  async refresh(): Promise<void> {
    try {
      const list = await firstValueFrom(this.http.get<PluginInfo[]>('/api/plugins'));
      this.plugins.set(list);
    } catch {
      // Non-fatal — leave the list as-is (UI gates stay closed).
    }
  }

  /** Enable a plugin. `consent` must be true for consent-gated plugins (412 otherwise). */
  async enable(id: string, consent = false): Promise<void> {
    await firstValueFrom(this.http.post(`/api/plugins/${id}/enable`, { consent }));
    await this.refresh();
  }

  async disable(id: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/plugins/${id}/disable`, {}));
    await this.refresh();
  }

  async saveConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await firstValueFrom(this.http.put(`/api/plugins/${id}/config`, config));
    await this.refresh();
  }
}
