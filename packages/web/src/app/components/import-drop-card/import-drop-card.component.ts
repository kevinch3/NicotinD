import { Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { IconComponent } from '../icon/icon.component';

export type ImportDropState = 'manifest' | 'uploading' | 'committing' | 'error';

export interface ImportDropSummary {
  fileCount: number;
  albumCount: number;
  totalBytes: number;
  skipped: string[];
}

const EMPTY_SUMMARY: ImportDropSummary = {
  fileCount: 0,
  albumCount: 0,
  totalBytes: 0,
  skipped: [],
};

/** Human size for the manifest line. Exported so it is testable without rendering. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * How many distinct album folders a manifest spans. The server groups by
 * directory, so this is what the user will see land — counting *files* would
 * promise a 3-album drop as "37 things".
 */
export function albumCountOf(paths: string[]): number {
  const dirs = new Set<string>();
  for (const p of paths) {
    const idx = p.lastIndexOf('/');
    dirs.add(idx === -1 ? '' : p.slice(0, idx));
  }
  return dirs.size;
}

/**
 * The drop card: what a dragged folder or zip becomes before it is an import
 * job (docs/import.md).
 *
 * Deliberately styled like the link-intent card and a blended result row — a
 * search, a pasted link and a dropped folder are three ways to do one thing, so
 * they should not look like three different features.
 *
 * Ends at `committing`: once the server accepts the commit the row is a real
 * acquisition job, and the Downloads feed owns it from there. Showing a second
 * card for the same work would be the twin-row bug (#673) by construction.
 */
@Component({
  selector: 'app-import-drop-card',
  standalone: true,
  imports: [TranslatePipe, IconComponent],
  templateUrl: './import-drop-card.component.html',
})
export class ImportDropCardComponent {
  // Not `input.required`: the card is nested in the Get page, and a required
  // signal input throws NG0950 there under the JIT unit harness.
  readonly state = input<ImportDropState>('manifest');
  readonly summary = input<ImportDropSummary>(EMPTY_SUMMARY);
  /** 0–99 while uploading; never 100 — the commit completes an upload. */
  readonly percent = input(0);
  readonly error = input<string | null>(null);

  readonly start = output<void>();
  readonly cancel = output<void>();

  readonly sizeLabel = computed(() => formatBytes(this.summary().totalBytes));
  readonly busy = computed(() => this.state() === 'uploading' || this.state() === 'committing');
}
