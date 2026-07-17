import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Client-side mirror of the server's `splitOnDelimiters` (artist-split.ts) used only
 * to PREFILL the member chips — the server re-validates every submission. Mirrored
 * (not imported) because the web bundle can't pull the server module, same trade-off
 * as lib/hunt-queries.ts.
 */
export function splitArtistParts(raw: string): string[] {
  const delimiters = [
    /\s*;\s*/,
    / & /i,
    / and /i,
    /\s*,\s+/,
    / \/ /,
    / \+ /,
    / vs\.? /i,
    / x /i,
    / y /i,
    / con /i,
  ];
  for (const delim of delimiters) {
    const parts = raw
      .split(delim)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return [raw];
}

export type IdentityMode = 'single' | 'split' | 'merge' | 'rename';

/**
 * Admin fix for a wrong artist-identity decision (docs/library-scanner.md): mark a
 * compound as ONE act, force-split it into member artists, merge a spelling variant
 * into another artist, or rename this artist to a corrected spelling/name. Writes the
 * permanent `source='user'` authority row via POST /api/library/artists/identity,
 * which runs the rescan synchronously so the change is applied before it returns.
 */
@Component({
  selector: 'app-artist-identity-modal',
  standalone: true,
  imports: [FormsModule, IconComponent],
  templateUrl: './artist-identity-modal.component.html',
})
export class ArtistIdentityModalComponent {
  private api = inject(LibraryApiService);
  private toasts = inject(ToastService);

  /** The raw artist string the decision applies to (tag spelling, not a display name). */
  readonly rawName = input.required<string>();
  readonly closed = output<void>();
  /** Emitted after the server applied the fix and its rescan has completed. */
  readonly saved = output<void>();

  readonly mode = signal<IdentityMode>('single');
  readonly members = signal<string[]>([]);
  readonly mergeTarget = signal('');
  readonly renameTarget = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // Prefill the member chips + the rename field whenever a new raw name opens.
    effect(() => {
      const raw = this.rawName();
      untracked(() => {
        this.members.set(splitArtistParts(raw));
        this.renameTarget.set(raw);
      });
    });
  }

  readonly memberList = computed(() => this.members());

  readonly canSave = computed(() => {
    if (this.busy()) return false;
    switch (this.mode()) {
      case 'single':
        return true;
      case 'split':
        return (
          this.memberList()
            .map((m) => m.trim())
            .filter(Boolean).length >= 2
        );
      case 'merge':
        return this.mergeTarget().trim().length > 0;
      case 'rename': {
        const next = this.renameTarget().trim();
        return next.length > 0 && next !== this.rawName();
      }
    }
  });

  updateMember(index: number, value: string): void {
    this.members.update((list) => list.map((m, i) => (i === index ? value : m)));
  }

  removeMember(index: number): void {
    this.members.update((list) => list.filter((_, i) => i !== index));
  }

  addMember(): void {
    this.members.update((list) => [...list, '']);
  }

  save(): void {
    if (!this.canSave()) return;
    const mode = this.mode();
    const payload =
      mode === 'merge'
        ? { rawName: this.rawName(), mergeInto: this.mergeTarget().trim() }
        : mode === 'rename'
          ? { rawName: this.rawName(), rename: this.renameTarget().trim() }
          : mode === 'split'
            ? {
                rawName: this.rawName(),
                decision: 'split' as const,
                members: this.memberList()
                  .map((m) => m.trim())
                  .filter(Boolean),
              }
            : { rawName: this.rawName(), decision: 'single' as const };

    this.busy.set(true);
    this.error.set(null);
    this.api.fixArtistIdentity(payload).subscribe({
      next: () => {
        this.busy.set(false);
        this.toasts.show({ kind: 'success', message: 'Artist identity updated.' });
        this.saved.emit();
        this.closed.emit();
      },
      error: (err: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.error.set(err?.error?.error ?? 'Failed to save the fix');
      },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }
}
