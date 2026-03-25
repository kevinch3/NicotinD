import { useEffect, useMemo, useRef } from 'react';
import { useListControlsStore } from '@/stores/list-controls';

export interface SortOption {
  field: string;
  label: string;
}

interface UseListControlsConfig<T> {
  pageKey: string;
  items: T[];
  searchFields: (keyof T)[];
  sortOptions: SortOption[];
  defaultSort?: string;
  defaultDirection?: 'asc' | 'desc';
}

export function useListControls<T>(config: UseListControlsConfig<T>) {
  const { pageKey, items, searchFields, sortOptions, defaultSort, defaultDirection } = config;

  const store = useListControlsStore();
  const page = store.getPage(pageKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);

  // Initialize sort field on first mount if not set
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const current = useListControlsStore.getState().getPage(pageKey);
    if (!current.sortField && (defaultSort || sortOptions.length > 0)) {
      useListControlsStore.getState().setSortField(pageKey, defaultSort ?? sortOptions[0].field);
    }
    if (defaultDirection && current.sortDirection !== defaultDirection && !useListControlsStore.getState().pages[pageKey]) {
      useListControlsStore.getState().toggleSortDirection(pageKey);
    }
  }, [pageKey, defaultSort, defaultDirection, sortOptions]);

  // Ctrl+F / Cmd+F keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        const current = useListControlsStore.getState().getPage(pageKey);
        if (current.isToolbarVisible) {
          // Already visible — focus the input
          inputRef.current?.focus();
        } else {
          useListControlsStore.getState().setToolbarVisible(pageKey, true);
          // Focus after render
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }
      if (e.key === 'Escape') {
        const current = useListControlsStore.getState().getPage(pageKey);
        if (current.isToolbarVisible) {
          useListControlsStore.getState().setToolbarVisible(pageKey, false);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pageKey]);

  // Filter + sort
  const filtered = useMemo(() => {
    let result = [...items];

    // Filter by search text
    const query = page.searchText.toLowerCase().trim();
    if (query) {
      result = result.filter((item) =>
        searchFields.some((field) => {
          const value = item[field];
          if (value == null) return false;
          return String(value).toLowerCase().includes(query);
        }),
      );
    }

    // Sort
    const sortField = page.sortField;
    if (sortField) {
      const dir = page.sortDirection === 'asc' ? 1 : -1;
      result.sort((a, b) => {
        const aVal = (a as Record<string, unknown>)[sortField];
        const bVal = (b as Record<string, unknown>)[sortField];
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
  }, [items, page.searchText, page.sortField, page.sortDirection, searchFields]);

  return {
    filtered,
    searchText: page.searchText,
    setSearchText: (text: string) => store.setSearchText(pageKey, text),
    sortField: page.sortField,
    setSortField: (field: string) => store.setSortField(pageKey, field),
    sortDirection: page.sortDirection,
    toggleSortDirection: () => store.toggleSortDirection(pageKey),
    isToolbarVisible: page.isToolbarVisible,
    showToolbar: () => {
      store.setToolbarVisible(pageKey, true);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    hideToolbar: () => store.setToolbarVisible(pageKey, false),
    toggleToolbar: () => store.toggleToolbar(pageKey),
    sortOptions,
    inputRef,
  };
}
