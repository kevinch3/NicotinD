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
 *
 * **There is no Loading story on purpose.** The shelf shows a `shelf-tile` skeleton
 * while fetching, but *only* when a persisted last-played track says this listener has
 * history — otherwise a fresh install would flash a shelf it is about to hide again.
 * Staging that here would mean a pending HTTP fixture, and the story interceptor answers
 * synchronously; adding a delay would put timing into the `smoke:storybook` gate for no
 * extra coverage. The gate logic has four rendering tests in the spec, and the skeleton's
 * shape is `Components/Skeleton` → `Shelf`.
 */
export const Default: Story = {};
