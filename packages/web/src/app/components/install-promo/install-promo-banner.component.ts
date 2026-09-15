import { Component, inject } from '@angular/core';
import { InstallPromptService } from '../../services/install-prompt.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The one-time install promotion (web.dev "promote-install", banner pattern).
 * Renders in the layout's banner slot, so only a signed-in user ever sees it —
 * that sign-in is the engagement signal the pattern asks for. Shown only once
 * `beforeinstallprompt` was captured (or on iOS, where the manual path is the
 * only one), dismissed once per device. The permanent offer lives in
 * Settings → Updates; this strip is the nudge, not the affordance.
 */
@Component({
  selector: 'app-install-promo-banner',
  imports: [TranslatePipe],
  templateUrl: './install-promo-banner.component.html',
})
export class InstallPromoBannerComponent {
  readonly install = inject(InstallPromptService);
}
