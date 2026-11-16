import type { Meta, StoryObj } from '@storybook/angular-vite';
import { IconTabsComponent, type IconTabItem } from './icon-tabs.component';

const LIBRARY: IconTabItem[] = [
  { value: 'songs', label: 'library.tab.songs', icon: 'music' },
  { value: 'albums', label: 'library.tab.albums', icon: 'disc-album' },
  { value: 'compilations', label: 'library.tab.compilations', icon: 'layers' },
  { value: 'singles', label: 'library.tab.singles', icon: 'disc' },
  { value: 'artists', label: 'library.tab.artists', icon: 'mic-vocal' },
  { value: 'genre', label: 'library.tab.genre', icon: 'tag' },
  { value: 'playlists', label: 'library.tab.playlists', icon: 'list-music' },
];

const meta: Meta<IconTabsComponent> = {
  title: 'Components/IconTabs',
  component: IconTabsComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The app-wide tab bar (#1668): every tab shows its icon, only the active one also shows its label. An inactive label stays in the DOM as `sr-only`, so each button keeps its accessible name, and each has a `title`. `variant` picks the roles: `nav` (buttons with `aria-current`), `tabs` (`tablist`) or `radio` (`radiogroup`).',
      },
    },
  },
  args: { items: LIBRARY, active: 'songs', variant: 'nav' },
};

export default meta;
type Story = StoryObj<IconTabsComponent>;

/** Seven tabs: the Library's own set. */
export const SevenTabs: Story = {};

export const ThreeTabs: Story = { args: { items: LIBRARY.slice(0, 3), active: 'albums' } };

/** A long active label truncates; the bar never scrolls sideways. */
export const LastTabActive: Story = { args: { active: 'compilations' } };

/** A count stays visible on an inactive tab, on the icon; inline once the tab is active. */
export const WithBadge: Story = {
  args: {
    items: [
      { value: 'songs', label: 'library.tab.songs', icon: 'music' },
      { value: 'albums', label: 'library.tab.albums', icon: 'disc-album', badge: 4 },
      { value: 'artists', label: 'library.tab.artists', icon: 'mic-vocal', badge: '' },
    ],
  },
};

export const AsTablist: Story = { args: { variant: 'tabs', label: 'library.tab.albums' } };

export const AsRadioGroup: Story = {
  args: { variant: 'radio', items: LIBRARY.slice(0, 2), label: 'library.tab.albums' },
};
