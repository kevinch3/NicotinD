import { Directive, HostListener, Input } from '@angular/core';
import * as Sentry from '@sentry/angular';

@Directive({
  selector: '[appSentryCta]',
  standalone: true
})
export class SentryCtaDirective {
  @Input('appSentryCta') ctaName!: string;

  @HostListener('click', ['$event'])
  onClick(event: Event) {
    if (this.ctaName) {
      Sentry.captureMessage(`CTA Clicked: ${this.ctaName}`, {
        level: 'info',
        tags: {
          type: 'cta_click',
          cta_name: this.ctaName
        }
      });
    }
  }
}
