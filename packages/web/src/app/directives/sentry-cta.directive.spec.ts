import { vi } from 'vitest';
import * as Sentry from '@sentry/angular';
import { SentryCtaDirective } from './sentry-cta.directive';

vi.mock('@sentry/angular', () => ({
  captureMessage: vi.fn(),
}));

describe('SentryCtaDirective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures a CTA message with tags on click', () => {
    const directive = new SentryCtaDirective();
    directive.ctaName = 'download-album';
    directive.onClick(new Event('click'));

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'CTA Clicked: download-album',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({ type: 'cta_click', cta_name: 'download-album' }),
      }),
    );
  });

  it('does nothing when ctaName is empty', () => {
    const directive = new SentryCtaDirective();
    directive.onClick(new Event('click'));
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
