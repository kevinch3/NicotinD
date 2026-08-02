import { Component, computed, effect, input, signal } from '@angular/core';
import { SettingsGroupHeaderComponent } from '../settings-group-header/settings-group-header.component';
import { IconComponent, type IconName } from '../icon/icon.component';

const KEY_PREFIX = 'nicotind-admin-group-';

/**
 * Collapsible wrapper around `SettingsGroupHeaderComponent` for the Admin
 * panel specifically. Settings/Extensions stay always-expanded (short pages);
 * Admin's 8 groups are collapsible because grouping alone doesn't shrink a
 * page whose content is inherently large — collapse is the actual lever.
 * Composition, not a modification of the shared header: Settings/Extensions
 * are unaffected by this component's existence.
 */
@Component({
  selector: 'app-admin-group',
  standalone: true,
  imports: [SettingsGroupHeaderComponent, IconComponent],
  templateUrl: './admin-group.component.html',
})
export class AdminGroupComponent {
  // Not `.required()`: this component is always nested inside AdminComponent's
  // template with property bindings, and this repo's JIT vitest harness never
  // registers a signal input() on a nested imported component (see
  // packages/web/src/testing/signal-input.ts) — a required input would throw
  // NG0950 during admin.component.spec.ts's change detection the moment Task 4
  // renders 8 of these. Plain defaults cost nothing since every real call site
  // always passes all inputs anyway (same reasoning as SettingsGroupHeaderComponent).
  readonly icon = input<IconName>('play');
  readonly title = input('');
  readonly description = input('');
  /** localStorage key suffix — stable, kebab-case, unique per group. */
  readonly groupId = input('');
  /** Used only when no value is stored yet for this groupId. */
  readonly defaultOpen = input(false);

  private readonly stored = signal<boolean | null>(null);
  private initialized = false;

  readonly open = computed(() => this.stored() ?? this.defaultOpen());

  constructor() {
    effect(() => {
      const id = this.groupId();
      if (this.initialized) return;
      this.initialized = true;
      try {
        const raw = localStorage.getItem(KEY_PREFIX + id);
        if (raw === 'true') this.stored.set(true);
        else if (raw === 'false') this.stored.set(false);
        // any other value (missing, corrupt) leaves stored() at null, so
        // open() falls back to defaultOpen().
      } catch {
        // localStorage unavailable (private mode, disabled) — fall back silently.
      }
    });
  }

  toggle(): void {
    const next = !this.open();
    this.stored.set(next);
    localStorage.setItem(KEY_PREFIX + this.groupId(), String(next));
  }
}
