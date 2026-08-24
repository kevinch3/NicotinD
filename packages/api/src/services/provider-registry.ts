import type { IBrowseProvider, ISearchProvider, ProviderType } from '@nicotind/core';

export class ProviderRegistry {
  private providers = new Map<string, ISearchProvider>();

  register(provider: ISearchProvider): void {
    this.providers.set(provider.name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  getByType(type: ProviderType): ISearchProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.type === type);
  }

  getByName(name: string): ISearchProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): ISearchProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * The browse lane's single source of truth. Method presence is NOT the test:
   * one adapter class serves every addon, so `'browseUser' in provider` was true
   * even for addons that never declared the capability — the UI then offered
   * "Load full tree" and the failure flattened into one opaque string (#666).
   * A provider that declares `supportsBrowse: false` is skipped; one that says
   * nothing is assumed capable (in-process providers predate the flag).
   */
  getBrowseProvider(): IBrowseProvider | null {
    for (const provider of this.providers.values()) {
      const declaresNoBrowse = (provider as { supportsBrowse?: boolean }).supportsBrowse === false;
      if (
        !declaresNoBrowse &&
        'browseUser' in provider &&
        typeof (provider as IBrowseProvider).browseUser === 'function'
      ) {
        return provider as IBrowseProvider;
      }
    }
    return null;
  }
}
