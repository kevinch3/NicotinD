import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { WelcomeBannerComponent } from './welcome-banner.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<WelcomeBannerComponent> = {
  title: 'Components/WelcomeBanner',
  component: WelcomeBannerComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'First-login greeting for a user an admin provisioned — they never see the setup wizard, so this is their only orientation. Dismissal is persisted server-side (`welcomeDismissed` on the profile), not per-device, so it does not reappear on their second device.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<WelcomeBannerComponent>;

/**
 * First-login greeting for a user an admin provisioned — they never see the setup wizard,
 * so this is their only orientation. Dismissal is persisted server-side
 * (`welcomeDismissed` on the profile), not per-device, so it does not reappear on a
 * second device.
 */
export const Dismissed: Story = {};

/** What a freshly provisioned user sees on first login. */
export const FirstLogin: Story = {
  decorators: [applicationConfig({ providers: storyProviders({ role: 'user' }) })],
};
