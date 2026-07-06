import { Injectable, signal, computed, type Signal } from '@angular/core';

export interface SortOption {
  field: string;
  label: string;
}

interface PageState {
  /** Raw text bound to the search input — updates on every keystroke. */
  searchText: string;
  /** Debounced text the (expensive) `filtered` computed reads — trails `searchText`. */
  debouncedSearchText: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
}

const DEFAULT_STATE: PageState = {
  searchText: '',
  debouncedSearchText: '',
  sortField: '',
  sortDirection: 'asc',
};

/** How long to wait after the last keystroke before re-running filter+sort.
 * Large lists (all artists, a 5000-song genre) copy+filter+sort per recompute,
 * so debouncing collapses a typing burst into one pass. */
const SEARCH_DEBOUNCE_MS = 200;

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
  private searchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private getPage(pageKey: string): PageState {
    return this.pages()[pageKey] ?? DEFAULT_STATE;
  }

  private updatePage(pageKey: string, patch: Partial<PageState>): void {
    this.pages.update((pages) => ({
      ...pages,
      [pageKey]: { ...(pages[pageKey] ?? DEFAULT_STATE), ...patch },
    }));
  }

  /** Reflect the keystroke immediately (input binding) and debounce the value the
   * `filtered` computed reads, so a typing burst triggers a single filter+sort. */
  private setSearchText(pageKey: string, text: string): void {
    this.updatePage(pageKey, { searchText: text });
    const existing = this.searchTimers.get(pageKey);
    if (existing) clearTimeout(existing);
    this.searchTimers.set(
      pageKey,
      setTimeout(() => {
        this.searchTimers.delete(pageKey);
        this.updatePage(pageKey, { debouncedSearchText: text });
      }, SEARCH_DEBOUNCE_MS),
    );
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

    // Initialize defaults if not already set (capture isNewPage before any updatePage call)
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

    const debouncedSearch = computed(() => this.getPage(pageKey).debouncedSearchText);

    const filtered = computed(() => {
      let result = [...items()];

      const query = debouncedSearch().toLowerCase().trim();
      if (query) {
        result = result.filter((item) =>
          searchFields.some((field) => {
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
      setSearchText: (text: string) => this.setSearchText(pageKey, text),
      setSortField: (field: string) => this.updatePage(pageKey, { sortField: field }),
      toggleSortDirection: () => {
        const cur = this.getPage(pageKey);
        this.updatePage(pageKey, { sortDirection: cur.sortDirection === 'asc' ? 'desc' : 'asc' });
      },
    };
  }

  reset(): void {
    for (const timer of this.searchTimers.values()) {
      clearTimeout(timer);
    }
    this.searchTimers.clear();
    this.pages.set({});
  }
}
