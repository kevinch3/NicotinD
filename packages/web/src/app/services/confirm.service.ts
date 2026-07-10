import { Injectable, signal } from '@angular/core';

/**
 * Global confirm dialog. A single modal (see ConfirmDialogComponent, mounted in
 * the layout) renders whatever `request()` holds; callers await `ask()`. Root
 * so any service/page shares one modal instead of hand-rolling askConfirm.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<{ message: string } | null>(null);
  private pending: ((ok: boolean) => void) | null = null;

  ask(message: string): Promise<boolean> {
    // A prior open request resolves false before we replace it.
    this.pending?.(false);
    this.request.set({ message });
    return new Promise<boolean>((res) => (this.pending = res));
  }

  resolve(ok: boolean): void {
    this.request.set(null);
    const p = this.pending;
    this.pending = null;
    p?.(ok);
  }
}
