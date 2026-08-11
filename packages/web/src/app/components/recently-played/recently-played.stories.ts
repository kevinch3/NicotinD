import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { RecentlyPlayedComponent } from './recently-played.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<RecentlyPlayedComponent> = {
  title: 'Components/RecentlyPlayed',
  component: RecentlyPlayedComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<RecentlyPlayedComponent>;

/**
 * The landing-page shelf, backed by `play_events`. A play is counted server-side by the
 * Last.fm rule (half the track or four minutes, 30 s floor) — the client only reports raw
 * facts, so the threshold stays retunable rather than frozen in shipped clients.
 *
 * `GET /api/stream/:id` is deliberately *not* the signal: preloads, preserved offline
 * tracks and share tokens would all attribute wrongly.
 */
export const Default: Story = {};
