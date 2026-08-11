import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PluginInfo } from '../../services/plugin.service';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { pluginStatus, type PluginStatus } from '../../lib/plugin-status';
import { IconComponent } from '../../components/icon/icon.component';
import { SlskdSettingsComponent } from './slskd/slskd-settings.component';
import { AddonStatusPanelComponent } from './addon-status-panel.component';
import { readGroupOpen, writeGroupOpen } from '../../lib/group-state';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * One extension card on the Extensions page. A real component rather than the
 * shared `<ng-template #card>` + `ngTemplateOutlet` it replaces, because the
 * template form broke D-pad navigation on the whole page: an embedded view is
 * created from its template's DECLARATION context (`TemplateRef`'s
 * `_declarationLView`/`_declarationTContainer`), and Angular's node injector
 * walks that declaration ancestry — not the DOM position of the
 * `<ng-container [ngTemplateOutlet]>` that instantiated it. The template was
 * declared as a SIBLING of the three `<section appTvNavGroup>` blocks, so
 * every `appTvNavItem` inside it resolved
 * `inject(TvNavGroupDirective, {optional:true})` to `null`, never registered,
 * and each group's `items()` stayed empty — a silent no-op, since `onKeydown`
 * just returns early on an empty group. (`ngTemplateOutletInjector` does not
 * help: it feeds `embeddedViewInjector`, which is part of the environment
 * injector fallback chain, not the node-injector chain this DI relies on.)
 *
 * DI *does* cross a real component's view boundary — the same mechanism
 * `TrackRowComponent`'s title button relies on — so a card rendered inside a
 * `<section appTvNavGroup>` correctly resolves to that section's group.
 *
 * Inputs/outputs are the classic decorator API, not `input()`/`output()`, to
 * match the rest of this codebase's TV-nav work: the signal-based functions do
 * not populate under this project's hand-rolled vitest+JIT harness (see
 * `TvNavGroupDirective`'s class comment).
 *
 * Task 4 (settings-cards unification): the header row (name, status pill,
 * Enable/Disable) stays always visible; description/capabilities/binaries
 * warning/config form collapse into a body, mirroring
 * `SettingsGroupComponent`'s persisted-per-device open/closed state
 * (`lib/group-state.ts`, id `plugin-<plugin.id>`) but as a plain
 * `@Input`/`@Output`-era signal rather than that component's `input()`s, for
 * the same JIT-harness reason above. slskd no longer has its own route —
 * `SlskdSettingsComponent` is embedded directly in this card's body (see its
 * class docstring), so its status poll only runs while the card is expanded
 * (an `@if`-gated body unmounts it on collapse, running `ngOnDestroy`).
 */
@Component({
  selector: 'app-plugin-card',
  standalone: true,
  imports: [
    FormsModule,
    TvNavItemDirective,
    IconComponent,
    SlskdSettingsComponent,
    AddonStatusPanelComponent,
    TranslatePipe,
  ],
  templateUrl: './plugin-card.component.html',
})
export class PluginCardComponent {
  @Input({ required: true }) plugin!: PluginInfo;
  /** Whether a mutation is in flight page-wide (disables both buttons). */
  @Input() busy = false;
  /** This plugin's editable config values, keyed by field key. */
  @Input() draft: Record<string, string> = {};

  @Output() readonly toggle = new EventEmitter<PluginInfo>();
  @Output() readonly save = new EventEmitter<PluginInfo>();
  @Output() readonly fieldChange = new EventEmitter<{ key: string; value: string }>();
  /** Remote addons only: request removal of this addon's registration. */
  @Output() readonly remove = new EventEmitter<PluginInfo>();

  private openState: boolean | null = null;

  /** Collapsed by default; restores the per-device persisted state on first
   *  read (mirrors `SettingsGroupComponent.open`, but as a plain getter since
   *  this component has no signal inputs to drive an `effect()` off of). */
  isOpen(): boolean {
    if (this.openState === null) {
      this.openState = readGroupOpen(localStorage, this.groupId()) ?? false;
    }
    return this.openState;
  }

  toggleOpen(): void {
    const next = !this.isOpen();
    this.openState = next;
    writeGroupOpen(localStorage, this.groupId(), next);
  }

  groupId(): string {
    return `plugin-${this.plugin.id}`;
  }

  draftValue(key: string): string {
    return this.draft[key] ?? '';
  }

  /** The plugin's required binaries as one display string, or null when it
   *  declares none. */
  missingBinaries(): string | null {
    const binaries = this.plugin.requirements?.binaries;
    return binaries?.length ? binaries.join(', ') : null;
  }

  /** The unified status pill state — see `pluginStatus()` for priority order. */
  status(): PluginStatus {
    return pluginStatus(this.plugin);
  }
}
