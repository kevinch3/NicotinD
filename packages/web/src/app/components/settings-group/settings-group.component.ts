import { Component, computed, effect, input, output, signal } from '@angular/core';
import { SettingsGroupHeaderComponent } from '../settings-group-header/settings-group-header.component';
import { IconComponent, type IconName } from '../icon/icon.component';
import { readGroupOpen, writeGroupOpen } from '../../lib/group-state';

/**
 * Collapsible bordered card wrapper around `SettingsGroupHeaderComponent`,
 * shared by every settings-family page (Admin today; Settings/Extensions/
 * Devices/Agent tokens migrate onto it in later tasks). Every group is
 * collapsed by default and persists its own open/closed state per device
 * (`lib/group-state.ts`), cleared on signout so a shared device never leaks
 * one user's expand/collapse habits into the next session. Superseded
 * rationale: this used to be Admin-only (`AdminGroupComponent`) on the theory
 * that Settings/Extensions were short enough to stay always-expanded — the
 * unification plan settled on one collapsible card everywhere instead.
 */
@Component({
  selector: 'app-settings-group',
  standalone: true,
  imports: [SettingsGroupHeaderComponent, IconComponent],
  templateUrl: './settings-group.component.html',
})
export class SettingsGroupComponent {
  // Not `.required()`: this component is always nested inside a parent
  // template with property bindings, and this repo's JIT vitest harness never
  // registers a signal input() on a nested imported component (see
  // packages/web/src/testing/signal-input.ts) — a required input would throw
  // NG0950 during a host page spec's change detection. Plain defaults cost
  // nothing since every real call site always passes all inputs anyway (same
  // reasoning as SettingsGroupHeaderComponent).
  readonly icon = input<IconName>('play');
  readonly title = input('');
  readonly description = input('');
  /** localStorage key suffix — stable, kebab-case, unique per group. */
  readonly groupId = input('');
  /** Used only when no value is stored yet for this groupId. */
  readonly defaultOpen = input(false);

  /** Emits whenever the group transitions to open — including a
   * restored-open/defaultOpen resolution at init (Devices' pairing panel
   * needs to react the moment its group becomes visible). Never double-fires:
   * init resolves the starting state and emits at most once before any
   * toggle runs. */
  readonly opened = output<void>();

  private readonly stored = signal<boolean | null>(null);
  private initialized = false;
  private hasEmittedOpen = false;

  readonly open = computed(() => this.stored() ?? this.defaultOpen());

  constructor() {
    effect(() => {
      const id = this.groupId();
      if (this.initialized) return;
      this.initialized = true;
      const restored = readGroupOpen(localStorage, id);
      if (restored !== null) this.stored.set(restored);
      const resolvedOpen = restored ?? this.defaultOpen();
      if (resolvedOpen) {
        this.hasEmittedOpen = true;
        this.opened.emit();
      }
    });
  }

  toggle(): void {
    const next = !this.open();
    this.stored.set(next);
    writeGroupOpen(localStorage, this.groupId(), next);
    if (next) {
      if (!this.hasEmittedOpen) {
        this.hasEmittedOpen = true;
        this.opened.emit();
      }
    } else {
      this.hasEmittedOpen = false;
    }
  }
}
