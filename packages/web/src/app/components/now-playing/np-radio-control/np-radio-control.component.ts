import { Component } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RadioChipComponent } from '../radio-chip/radio-chip.component';
import { MenuPanelComponent } from '../../menu-panel/menu-panel.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { OverflowRevealDirective } from '../../../directives/overflow-reveal.directive';

/**
 * The Now Playing radio control (#1715, owner's layout B): one 44px icon at the
 * end of the transport row. Off, a tap starts the radio; on, it shows an
 * accent fill + dot and a tap opens the variety dial (#1660), whose switch
 * turns radio off. Same state and logic as the chip it extends — what changes
 * is the trigger, and that the dial opens as a menu panel (a bottom sheet on a
 * phone, #1714) instead of a row that pushed the queue down. TV keeps the chip.
 */
@Component({
  selector: 'app-np-radio-control',
  imports: [NgTemplateOutlet, MenuPanelComponent, TranslatePipe, OverflowRevealDirective],
  templateUrl: './np-radio-control.component.html',
  host: { class: 'contents' },
})
export class NpRadioControlComponent extends RadioChipComponent {}
