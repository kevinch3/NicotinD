import { Component, input } from '@angular/core';
import { IconComponent, type IconName } from '../icon/icon.component';

/**
 * Uniform header for a Settings page group card: an icon in a tinted box,
 * a title, and a one-line description. Extracted into one component so
 * every group card (Appearance, Playback & Offline, Account & Devices,
 * Advanced) renders identically — sharing the header makes drift between
 * cards impossible rather than merely discouraged by convention.
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
