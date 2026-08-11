import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { UpdateBannerComponent } from './update-banner.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<UpdateBannerComponent> = {
  title: 'Components/UpdateBanner',
  component: UpdateBannerComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The universal install CTA for a new PWA version, shown once the service worker reports `VERSION_READY`. The Settings → "Check for updates" button is the manual trigger for the same flow, not a replacement for this banner.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<UpdateBannerComponent>;

/**
 * The universal install CTA: it appears once the service worker reports `VERSION_READY`.
 * The Settings → "Check for updates" button is the manual trigger for the same flow, not
 * a replacement for this banner.
 *
 * Storybook registers no service worker, so the banner stays hidden here — the story
 * documents where it lives and what triggers it.
 */
export const Default: Story = {};
