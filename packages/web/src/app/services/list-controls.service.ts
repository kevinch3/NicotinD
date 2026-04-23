import { Injectable, signal, computed, type Signal } from '@angular/core';

export interface SortOption {
  field: string;
  label: string;
}

interface PageState {
  searchText: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
}

const DEFAULT_STATE: PageState = {
  searchText: '',
  sortField: '',
  sortDirection: 'asc',
};

export interface ListControls<T> {
  filtered: Signal<T[]>;
  searchText: Signal<string>;
  sortField: Signal<string>;
  sortDirection: Signal<'asc' | 'desc'>;
  setSearchText(text: string): void;
  setSortField(field: string): void;
  toggleSortDirection(): void;
}

@Injectable({ providedIn: 'root' })
export class ListControlsService {
  private pages = signal<Record<string, PageState>>({});

  private getPage(pageKey: string): PageState {
    return this.pages()[pageKey] ?? DEFAULT_STATE;
  }

  private updatePage(pageKey: string, patch: Partial<PageState>): void {
    this.pages.update(pages => ({
      ...pages,
      [pageKey]: { ...(pages[pageKey] ?? DEFAULT_STATE), ...patch },
    }));
  }

  connect<T>(config: {
    pageKey: string;
    items: Signal<T[]>;
    searchFields: (keyof T)[];
    sortOptions: SortOption[];
    defaultSort?: string;
    defaultDirection?: 'asc' | 'desc';
  }): ListControls<T> {
    const { pageKey, items, searchFields, sortOptions, defaultSort, defaultDirection } = config;

    const current = this.getPage(pageKey);
    const isNewPage = !this.pages()[pageKey];
    if (!current.sortField && (defaultSort || sortOptions.length > 0)) {
      this.updatePage(pageKey, {
        sortField: defaultSort ?? sortOptions[0].field,
        ...(isNewPage && defaultDirection ? { sortDirection: defaultDirection } : {}),
      });
    } else if (isNewPage && defaultDirection) {
      this.updatePage(pageKey, { sortDirection: defaultDirection });
    }

    const searchText = computed(() => this.getPage(pageKey).searchText);
    const sortField = computed(() => this.getPage(pageKey).sortField);
    const sortDirection = computed(() => this.getPage(pageKey).sortDirection);

    const filtered = computed(() => {
      let result = [...items()];

      const query = searchText().toLowerCase().trim();
      if (query) {
        result = result.filter(item =>
          searchFields.some(field => {
            const value = item[field];
            if (value == null) return false;
            return String(value).toLowerCase().includes(query);
          }),
        );
      }

      const sf = sortField();
      if (sf) {
        const dir = sortDirection() === 'asc' ? 1 : -1;
        result.sort((a, b) => {
          const aVal = (a as Record<string, unknown>)[sf];
          const bVal = (b as Record<string, unknown>)[sf];
          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          if (typeof aVal === 'number' && typeof bVal === 'number') {
            return (aVal - bVal) * dir;
          }
          return String(aVal).localeCompare(String(bVal)) * dir;
        });
      }

      return result;
    });

    return {
      filtered,
      searchText,
      sortField,
      sortDirection,
      setSearchText: (text: string) => this.updatePage(pageKey, { searchText: text }),
      setSortField: (field: string) => this.updatePage(pageKey, { sortField: field }),
      toggleSortDirection: () => {
        const cur = this.getPage(pageKey);
        this.updatePage(pageKey, { sortDirection: cur.sortDirection === 'asc' ? 'desc' : 'asc' });
      },
    };
  }
}
