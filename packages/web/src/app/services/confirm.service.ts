import { Injectable, signal } from '@angular/core';

/**
 * Global confirm dialog. A single modal (see ConfirmHostComponent, mounted in
 * the layout) renders whatever `request()` holds; callers await `ask()`. Root
 * so any service/page shares one modal instead of hand-rolling askConfirm.
 */
export interface ConfirmLabels {
  confirmLabel?: string;
  cancelLabel?: string;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<({ message: string } & ConfirmLabels) | null>(null);
  private pending: ((ok: boolean) => void) | null = null;

  /** `labels` names the two choices, so a button never answers its own title (#1542). */
  ask(message: string, labels: ConfirmLabels = {}): Promise<boolean> {
    // A prior open request resolves false before we replace it.
    this.pending?.(false);
    this.request.set({ message, ...labels });
    return new Promise<boolean>((res) => (this.pending = res));
  }

  resolve(ok: boolean): void {
    this.request.set(null);
    const p = this.pending;
    this.pending = null;
    p?.(ok);
  }
}
