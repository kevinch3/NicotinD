import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, type Observable } from 'rxjs';
import type { SlskdStatus } from '@nicotind/core';

/** Mirrors `PluginKind` in `@nicotind/core` — keep the three in sync. A kind
 *  missing here has no group computed and no template section, so its plugins
 *  render nowhere at all (which is exactly how LRCLIB went unmanageable). */
export type PluginKind = 'acquisition' | 'metadata' | 'connectivity';
export type PluginCapability =
  'search' | 'browse' | 'resolve' | 'download' | 'lyrics' | 'genre' | 'connectivity';

export type PluginConfigFieldType = 'text' | 'password';

export interface PluginConfigField {
  key: string;
  label: string;
  type: PluginConfigFieldType;
  placeholder?: string;
  help?: string;
}

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
  configFields?: PluginConfigField[];
  /** Which config keys have a stored value (secrets are never returned). */
  configured?: Record<string, boolean>;
  /** Prefill values for non-secret (`text`) fields. */
  config?: Record<string, unknown>;
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
  readonly metadata = computed(() => this.plugins().filter((p) => p.kind === 'metadata'));
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
  /** The archive.org plugin specifically is enabled (gates the archive.org search lane). */
  readonly hasArchive = computed(() => this.plugins().some((p) => p.id === 'archive' && p.enabled));
  /** The Spotify metadata plugin is enabled (gates the Spotify fallback lane). */
  readonly hasSpotify = computed(() => this.plugins().some((p) => p.id === 'spotify' && p.enabled));
  /**
   * spotDL is enabled **and** available (binary present) — gates whether a
   * Spotify match downloads in one click. When false, the lane shows a manual
   * note instead (the download path is spotDL).
   */
  readonly hasSpotdl = computed(() =>
    this.plugins().some((p) => p.id === 'spotdl' && p.enabled && p.available),
  );

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

  /** Whether the slskd extension is enabled (gates its dedicated settings page). */
  readonly hasSlskd = computed(() => this.plugins().some((p) => p.id === 'slskd' && p.enabled));

  /** Live slskd status (speeds/limits/counts) for the extension's status panel. */
  getSlskdStatus(): Observable<SlskdStatus> {
    return this.http.get<SlskdStatus>('/api/plugins/slskd/status');
  }
}
