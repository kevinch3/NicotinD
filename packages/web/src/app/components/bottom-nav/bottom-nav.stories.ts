import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BottomNavComponent } from './bottom-nav.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';

/**
 * The mobile tab bar. Only renders below `md`, so review it in the **Mobile**
 * viewport — at desktop width it is `md:hidden` and the canvas looks empty.
 *
 * Its column count is **derived** from the visible tab count
 * (`repeat(N, minmax(0, 1fr))`), not a fixed `grid-cols-N`. That is the
 * regression worth seeing: the bar was once a hardcoded `grid-cols-5` with a
 * four-item listener case, which left a trailing empty column and pushed the
 * tabs off-centre. Compare the Listener and Acquirer stories side by side.
 */
const meta: Meta<BottomNavComponent> = {
  title: 'Components/BottomNav',
  component: BottomNavComponent,
  tags: ['autodocs'],
  parameters: { viewport: { defaultViewport: 'mobile' } },
};
export default meta;

type Story = StoryObj<BottomNavComponent>;

/** Stories differ only by injected state, so each declares its own providers. */
const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [BottomNavComponent] }),
  ],
});

/**
 * A listener cannot acquire, so `/get` is filtered out and the bar renders
 * **three** evenly-spaced tabs — the case the old hardcoded grid got wrong.
 */
export const Listener: Story = { ...withState({ role: 'listener' }) };

/** A user with acquisition rights: four tabs, still evenly spaced. */
export const Acquirer: Story = { ...withState({ role: 'user' }) };

/**
 * The badge sums three independent sources — slskd transfers, in-flight URL
 * acquisitions, and the download-inbox triage queue. Mobile once omitted the
 * acquire jobs, so a yt-dlp download showed a badge on desktop and none on the
 * phone; this story seeds one of each, so the number is only correct when all
 * three are counted.
 */
export const WithDownloadBadge: Story = {
  ...withState({
    role: 'user',
    downloadingTransfers: 2,
    activeAcquireJobs: 1,
    pendingReviews: 3,
  }),
};

/** A listener never sees the badge, because the tab it sits on is filtered out. */
export const ListenerIgnoresDownloads: Story = {
  ...withState({ role: 'listener', downloadingTransfers: 2, pendingReviews: 3 }),
};
