import { Component, input, output, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface SortOption {
  field: string;
  label: string;
}

@Component({
  selector: 'app-list-toolbar',
  imports: [FormsModule],
  template: `
    <div class="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-500 flex-shrink-0">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input #inputEl type="text" [ngModel]="searchText()" (ngModelChange)="searchChange.emit($event)"
        placeholder="Filter..." class="flex-1 min-w-0 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none" />

      @if (resultCount() != null && searchText()) {
        <span class="text-xs text-zinc-600 flex-shrink-0">{{ resultCount() }}</span>
      }

      <select [ngModel]="sortField()" (ngModelChange)="sortFieldChange.emit($event)"
        class="bg-zinc-800 border border-zinc-700/50 rounded text-xs text-zinc-300 px-2 py-1 outline-none cursor-pointer flex-shrink-0">
        @for (opt of sortOptions(); track opt.field) {
          <option [value]="opt.field">{{ opt.label }}</option>
        }
      </select>

      <button (click)="toggleDirection.emit()" class="p-1 text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
        [title]="sortDirection() === 'asc' ? 'Ascending' : 'Descending'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          [class]="sortDirection() === 'desc' ? 'rotate-180' : ''">
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </svg>
      </button>

      <button (click)="dismiss.emit()" class="p-1 text-zinc-600 hover:text-zinc-300 transition flex-shrink-0" title="Close (Esc)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  `,
})
export class ListToolbarComponent {
  readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('inputEl');

  readonly searchText = input('');
  readonly sortField = input('');
  readonly sortDirection = input<'asc' | 'desc'>('asc');
  readonly sortOptions = input<SortOption[]>([]);
  readonly resultCount = input<number | null>(null);

  readonly searchChange = output<string>();
  readonly sortFieldChange = output<string>();
  readonly toggleDirection = output<void>();
  readonly dismiss = output<void>();

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
