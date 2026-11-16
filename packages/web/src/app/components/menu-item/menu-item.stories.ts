import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { startsGroup } from '../../lib/menu-groups';
import { MenuItemComponent } from './menu-item.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { TrackAction } from '../track-row/track-row.component';

const noop = () => {};
const SONG_MENU: TrackAction[] = [
  { label: 'Like', group: 'play', labelKey: 'song.like', icon: 'heart', action: noop },
  {
    label: 'Add to queue',
    group: 'play',
    labelKey: 'song.addToQueue',
    icon: 'queue',
    action: noop,
  },
  { label: 'Play next', group: 'play', labelKey: 'song.playNext', icon: 'play-next', action: noop },
  { label: 'Start radio', group: 'play', labelKey: 'song.startRadio', icon: 'radio', action: noop },
  { label: 'Go to artist', group: 'goto', labelKey: 'song.goToArtist', icon: 'user', action: noop },
  {
    label: 'Go to album',
    group: 'goto',
    labelKey: 'song.goToAlbum',
    icon: 'disc-album',
    action: noop,
  },
  {
    label: 'Add to playlist',
    group: 'keep',
    labelKey: 'song.addToPlaylist',
    icon: 'list-music',
    action: noop,
  },
  {
    label: 'Save offline',
    group: 'keep',
    labelKey: 'song.saveOffline',
    icon: 'download',
    action: noop,
  },
  { label: 'Song info', group: 'info', labelKey: 'song.info', icon: 'info', action: noop },
  {
    label: "Don't recommend this",
    group: 'feedback',
    labelKey: 'song.dontRecommend',
    icon: 'thumbs-down',
    action: noop,
  },
  {
    label: 'Report this track',
    group: 'feedback',
    labelKey: 'report.menuItem',
    icon: 'flag',
    action: noop,
  },
  {
    label: 'Remove from library',
    group: 'remove',
    labelKey: 'song.removeFromLibrary',
    icon: 'delete',
    destructive: true,
    action: noop,
  },
];

const meta: Meta = {
  title: 'Components/MenuItem',
  parameters: {
    docs: {
      description: {
        component:
          'One row of an action menu: icon, label and destructive style. Every menu that lists actions (track rows, Now Playing, entity tiles, the album page) draws its rows through this, as an attribute on the button so the row stays a direct child of the menu panel.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};
export default meta;
type Story = StoryObj;

const menu = (actions: TrackAction[], tall: boolean) => ({
  props: { actions, tall, startsGroup },
  moduleMetadata: { imports: [MenuItemComponent] },
  template: `
    <div role="menu" aria-label="Song actions" class="w-64 rounded-xl border border-theme bg-theme-surface py-1 shadow-xl">
      @for (a of actions; track a.label; let i = $index) {
        @if (startsGroup(actions, i)) {
          <div role="separator" class="my-1 border-t border-theme"></div>
        }
        <button [appMenuItem]="a" [tall]="tall" role="menuitem"></button>
      }
    </div>`,
});

/** The song menu as a desktop popover. */
export const SongMenu: Story = { render: () => menu(SONG_MENU, false) };

/** The same rows at the 44px height a phone sheet uses. */
export const TallRows: Story = { render: () => menu(SONG_MENU, true) };

/** Actions without an icon keep the icon column, so labels stay aligned. */
export const MixedIcons: Story = {
  render: () =>
    menu(
      [
        ...SONG_MENU.slice(0, 2),
        { label: 'A page-specific action', action: noop },
        { label: 'A very long action label that has to truncate inside the menu', action: noop },
      ],
      false,
    ),
};
