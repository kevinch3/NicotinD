import { create } from 'zustand';

interface PageListState {
  searchText: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  isToolbarVisible: boolean;
}

interface ListControlsState {
  pages: Record<string, PageListState>;
  getPage: (pageKey: string) => PageListState;
  setSearchText: (pageKey: string, text: string) => void;
  setSortField: (pageKey: string, field: string) => void;
  toggleSortDirection: (pageKey: string) => void;
  setToolbarVisible: (pageKey: string, visible: boolean) => void;
  toggleToolbar: (pageKey: string) => void;
}

const DEFAULT_PAGE_STATE: PageListState = {
  searchText: '',
  sortField: '',
  sortDirection: 'asc',
  isToolbarVisible: false,
};

export const useListControlsStore = create<ListControlsState>((set, get) => ({
  pages: {},

  getPage: (pageKey) => get().pages[pageKey] ?? DEFAULT_PAGE_STATE,

  setSearchText: (pageKey, searchText) =>
    set((s) => ({
      pages: {
        ...s.pages,
        [pageKey]: { ...(s.pages[pageKey] ?? DEFAULT_PAGE_STATE), searchText },
      },
    })),

  setSortField: (pageKey, sortField) =>
    set((s) => ({
      pages: {
        ...s.pages,
        [pageKey]: { ...(s.pages[pageKey] ?? DEFAULT_PAGE_STATE), sortField },
      },
    })),

  toggleSortDirection: (pageKey) =>
    set((s) => {
      const current = s.pages[pageKey] ?? DEFAULT_PAGE_STATE;
      return {
        pages: {
          ...s.pages,
          [pageKey]: {
            ...current,
            sortDirection: current.sortDirection === 'asc' ? 'desc' : 'asc',
          },
        },
      };
    }),

  setToolbarVisible: (pageKey, isToolbarVisible) =>
    set((s) => ({
      pages: {
        ...s.pages,
        [pageKey]: { ...(s.pages[pageKey] ?? DEFAULT_PAGE_STATE), isToolbarVisible },
      },
    })),

  toggleToolbar: (pageKey) =>
    set((s) => {
      const current = s.pages[pageKey] ?? DEFAULT_PAGE_STATE;
      return {
        pages: {
          ...s.pages,
          [pageKey]: { ...current, isToolbarVisible: !current.isToolbarVisible },
        },
      };
    }),
}));
