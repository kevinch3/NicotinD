import type { RefObject } from 'react';
import type { SortOption } from '@/hooks/useListControls';

interface ListToolbarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  sortField: string;
  onSortFieldChange: (field: string) => void;
  sortDirection: 'asc' | 'desc';
  onToggleSortDirection: () => void;
  sortOptions: SortOption[];
  onDismiss: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  resultCount?: number;
}

export function ListToolbar({
  searchText,
  onSearchChange,
  sortField,
  onSortFieldChange,
  sortDirection,
  onToggleSortDirection,
  sortOptions,
  onDismiss,
  inputRef,
  resultCount,
}: ListToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
      {/* Search */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-zinc-500 flex-shrink-0"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={searchText}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Filter..."
        className="flex-1 min-w-0 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none"
      />

      {/* Result count */}
      {resultCount != null && searchText && (
        <span className="text-xs text-zinc-600 flex-shrink-0">
          {resultCount}
        </span>
      )}

      {/* Sort field */}
      <select
        value={sortField}
        onChange={(e) => onSortFieldChange(e.target.value)}
        className="bg-zinc-800 border border-zinc-700/50 rounded text-xs text-zinc-300 px-2 py-1 outline-none cursor-pointer flex-shrink-0"
      >
        {sortOptions.map((opt) => (
          <option key={opt.field} value={opt.field}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Sort direction */}
      <button
        onClick={onToggleSortDirection}
        className="p-1 text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
        title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={sortDirection === 'desc' ? 'rotate-180' : ''}
        >
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </svg>
      </button>

      {/* Dismiss */}
      <button
        onClick={onDismiss}
        className="p-1 text-zinc-600 hover:text-zinc-300 transition flex-shrink-0"
        title="Close (Esc)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
