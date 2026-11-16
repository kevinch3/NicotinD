import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ActionListComponent } from './action-list.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { TrackAction } from '../track-row/track-row.component';

const noop = () => {};
const PLAYLISTS: TrackAction[] = [
  {
    label: 'New playlist',
    action: noop,
    field: { kind: 'submit', placeholderKey: 'song.playlistNewName', submit: noop },
  },
  { label: 'Road Trip', icon: 'list-music', action: noop },
  { label: 'Sunday Morning', icon: 'list-music', action: noop },
  {
    label: 'A playlist with a very long name that has to truncate',
    icon: 'list-music',
    action: noop,
  },
];
const MENU: TrackAction[] = [
  { label: 'Like', labelKey: 'song.like', icon: 'heart', group: 'play', action: noop },
  {
    label: 'Add to queue',
    labelKey: 'song.addToQueue',
    icon: 'queue',
    group: 'play',
    action: noop,
  },
  {
    label: 'Go to album',
    labelKey: 'song.goToAlbum',
    icon: 'disc-album',
    group: 'goto',
    action: noop,
  },
  {
    label: 'Add to playlist',
    labelKey: 'song.addToPlaylist',
    icon: 'list-music',
    group: 'keep',
    action: noop,
    children: () => PLAYLISTS,
  },
  {
    label: 'Save offline',
    labelKey: 'song.saveOffline',
    icon: 'download',
    group: 'keep',
    action: noop,
  },
  { label: 'Song info', labelKey: 'song.info', icon: 'info', group: 'info', action: noop },
];

const meta: Meta = {
  title: 'Components/ActionList',
  parameters: {
    docs: {
      description: {
        component:
          'The rows of an action menu, with submenus. A row with children opens a flyout beside it in a desktop popover, and replaces the list under a Back row on a phone sheet or on TV. Field rows filter the list or submit typed text.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};
export default meta;
type Story = StoryObj;

const menu = (drillIn: boolean) => ({
  props: { actions: MENU, drillIn },
  moduleMetadata: { imports: [ActionListComponent] },
  template: `
    <div class="p-4" [style.padding-left.px]="drillIn ? 16 : 16">
      <app-action-list
        role="group"
        aria-label="Song actions"
        class="w-64 rounded-xl border border-theme bg-theme-surface py-1 shadow-xl"
        [actions]="actions"
        [drillIn]="drillIn"
        [tall]="drillIn"
      />
    </div>`,
});

const open: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId('track-action-Add to playlist'));
  await expect(await canvas.findByTestId('track-action-Road Trip')).toBeVisible();
};

/** The top level: a chevron marks the row that opens a submenu. */
export const TopLevel: Story = { render: () => menu(false) };

/** Desktop popover: the submenu flies out beside its row. */
export const Flyout: Story = { render: () => menu(false), play: open };

/** Phone sheet and TV: the submenu replaces the list, under a Back row. */
export const DrillIn: Story = { render: () => menu(true), play: open };
