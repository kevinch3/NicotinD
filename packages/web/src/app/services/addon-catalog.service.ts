import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AddonCatalogEntry, AddonCatalogInstallState, ComposeSnippet } from '@nicotind/core';

/** A catalog entry plus its live install state (as served by GET /catalog). */
export type AddonCatalogItem = AddonCatalogEntry & { state: AddonCatalogInstallState };

/** The install response — a minted token + the snippet with it baked in. */
export interface AddonInstallResult {
  token: string;
  addonUrl: string;
  composeSnippet: ComposeSnippet;
  reused: boolean;
}

/**
 * The curated addon marketplace (issue #517). Fetches the vetted catalog + each
 * entry's install state; `install` mints a token + writes a pending
 * registration and hands back the compose snippet; a reachability promoter
 * (server-side, also triggered by `refresh`) flips the entry to installed once
 * its container is up.
 */
@Injectable({ providedIn: 'root' })
export class AddonCatalogService {
  private readonly http = inject(HttpClient);
  readonly items = signal<AddonCatalogItem[]>([]);
  readonly loaded = signal(false);

  async refresh(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ entries: AddonCatalogItem[] }>('/api/plugins/catalog'),
    );
    this.items.set(res.entries);
    this.loaded.set(true);
  }

  /** Mint a token + pending registration; returns the snippet to paste. */
  async install(id: string): Promise<AddonInstallResult> {
    return firstValueFrom(
      this.http.post<AddonInstallResult>(
        `/api/plugins/catalog/${encodeURIComponent(id)}/install`,
        {},
      ),
    );
  }

  /** Ask the server to re-check a pending install now (the "Check now" button). */
  async check(id: string): Promise<{ state: AddonCatalogInstallState; promoted: boolean }> {
    return firstValueFrom(
      this.http.post<{ state: AddonCatalogInstallState; promoted: boolean }>(
        `/api/plugins/catalog/${encodeURIComponent(id)}/check`,
        {},
      ),
    );
  }
}
