import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { HomeViewSwitchComponent } from './home-view-switch.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<HomeViewSwitchComponent> = {
  title: 'Components/HomeViewSwitch',
  component: HomeViewSwitchComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The Shelves | Mosaic switch on the home route. A radiogroup on the Library-tab pattern: every option shows its icon, only the active one its label; the inactive label stays as `sr-only` so both radios keep their accessible names. The home shell mounts it once, outside the view swap, top-left on the header content edge.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { view: 'mosaic' },
};

export default meta;
type Story = StoryObj<HomeViewSwitchComponent>;

export const Mosaic: Story = {};

export const Shelves: Story = { args: { view: 'shelves' } };
