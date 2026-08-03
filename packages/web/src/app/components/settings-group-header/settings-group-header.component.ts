import { Component, input } from '@angular/core';
import { IconComponent, type IconName } from '../icon/icon.component';

/**
 * Uniform header for a Settings page group card: an icon in a tinted box,
 * a title, and a one-line description. Extracted into one component so
 * every group card (Appearance, Playback & Offline, Account & Devices,
 * Advanced) renders identically — sharing the header makes drift between
 * cards impossible rather than merely discouraged by convention.
 *
 * Owns no bottom spacing of its own (moved onto `SettingsGroupComponent`'s
 * body, which needs the header flush against its clickable toggle button —
 * a collapsed card otherwise carries 20px of dead whitespace below the
 * header). The standalone call sites still using this header directly
 * (`settings.component.html`, `plugins.component.html`) lose that 20px until
 * they migrate onto `SettingsGroupComponent` in a later task.
 */
@Component({
  selector: 'app-settings-group-header',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './settings-group-header.component.html',
})
export class SettingsGroupHeaderComponent {
  readonly icon = input<IconName>('play');
  readonly title = input<string>('');
  readonly description = input<string>('');
}
