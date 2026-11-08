import { Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { IconComponent } from '../icon/icon.component';

/**
 * The Add tab's "Import from a folder" action (docs/import.md "The drop zone").
 *
 * A secondary action beside the acquisition lanes, so it is outlined rather than
 * filled. The dashed accent state mirrors the page-wide drop overlay: while a
 * folder is dragged anywhere over the Add tab the entry says "here", too.
 * Pressing it opens the `webkitdirectory` picker the page owns.
 */
@Component({
  selector: 'app-import-entry',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './import-entry.component.html',
  host: { class: 'block' },
})
export class ImportEntryComponent {
  /** A file drag is over the page. Not `input.required`: this component is nested. */
  readonly dragging = input(false);
  readonly pick = output<void>();

  readonly stateClass = computed(() => importEntryStateClass(this.dragging()));
}

/** The drag-over look: the overlay says "drop", and so does the entry itself. */
export function importEntryStateClass(dragging: boolean): string {
  return dragging
    ? 'border-dashed border-theme-accent bg-theme-accent/10'
    : 'border-theme hover:bg-theme-hover';
}
