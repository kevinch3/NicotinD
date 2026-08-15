import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AddonCatalogEntry, AddonCatalogInstallState } from '@nicotind/core';

/** A catalog entry plus its live install state (as served by GET /catalog). */
export type AddonCatalogItem = AddonCatalogEntry & { state: AddonCatalogInstallState };

/**
 * The curated addon marketplace (issue #517). Read-only in PR1: it fetches the
 * vetted catalog + each entry's install state so the Extensions page can render
 * install cards. The minted-token install flow is a separate call (PR2).
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
}
