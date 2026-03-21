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

  getBrowseProvider(): IBrowseProvider | null {
    for (const provider of this.providers.values()) {
      if (
        'browseUser' in provider &&
        typeof (provider as IBrowseProvider).browseUser === 'function'
      ) {
        return provider as IBrowseProvider;
      }
    }
    return null;
  }
}
