import { signal } from '@angular/core';
import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { InstallPromoBannerComponent } from './install-promo-banner.component';
import { InstallPromptService } from '../../services/install-prompt.service';
import { storyProviders } from '../../../stories/support/story-providers';

/**
 * The browser fires `beforeinstallprompt` on its own schedule and never inside
 * Storybook's iframe, so the states are stubbed rather than driven.
 */
function stubInstall(state: { show: boolean; canInstall: boolean }) {
  return {
    provide: InstallPromptService,
    useValue: {
      showPromotion: signal(state.show),
      canInstall: signal(state.canInstall),
      installing: signal(false),
      install: async () => 'accepted' as const,
      dismissPromotion: () => {},
    },
  };
}

const meta: Meta<InstallPromoBannerComponent> = {
  title: 'Components/InstallPromoBanner',
  component: InstallPromoBannerComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'One-time PWA install nudge in the layout banner slot (web.dev "promote-install"). Appears only after the browser reports the app installable (`beforeinstallprompt`), or on iOS where the manual Share → Add to Home Screen path is the only one. "Not now" is remembered per device; the permanent offer stays in Settings → Updates.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<InstallPromoBannerComponent>;

/** Chromium captured the prompt: a real Install button. */
export const Installable: Story = {
  decorators: [
    applicationConfig({
      providers: [...storyProviders(), stubInstall({ show: true, canInstall: true })],
    }),
  ],
};

/** iOS Safari: no prompt exists, only the instructions. */
export const IosManual: Story = {
  decorators: [
    applicationConfig({
      providers: [...storyProviders(), stubInstall({ show: true, canInstall: false })],
    }),
  ],
};

/** Already installed, dismissed, or a native shell: the strip renders nothing. */
export const Hidden: Story = {
  decorators: [
    applicationConfig({
      providers: [...storyProviders(), stubInstall({ show: false, canInstall: false })],
    }),
  ],
};
