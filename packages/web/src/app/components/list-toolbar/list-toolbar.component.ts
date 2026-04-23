import { Component, input, output, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface SortOption {
  field: string;
  label: string;
}

@Component({
  selector: 'app-list-toolbar',
  imports: [FormsModule],
  templateUrl: './list-toolbar.component.html',
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

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
