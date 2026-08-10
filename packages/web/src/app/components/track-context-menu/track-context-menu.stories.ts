import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { TrackContextMenuComponent } from './track-context-menu.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoTrack } from '../../../stories/support/fixtures';

const meta: Meta<TrackContextMenuComponent> = {
  title: 'Components/TrackContextMenu',
  component: TrackContextMenuComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artist: demoTrack.artist, position: { x: 160, y: 120 }, trackId: demoTrack.id },
};

export default meta;
type Story = StoryObj<TrackContextMenuComponent>;

/** Long-press / right-click menu, positioned at the pointer rather than at a trigger. */
export const Default: Story = {};

export const NearTopLeft: Story = { args: { position: { x: 24, y: 24 } } };

/** Without a `trackId` the song-info entry has nothing to open, so it is omitted. */
export const WithoutTrackId: Story = { args: { trackId: undefined } };
