import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { LayoutComponent } from './layout.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import { demoTrack, demoTracks } from '../../../stories/support/fixtures';

/**
 * The app shell: header, offline banner, the routed `<main>`, the mini-player,
 * the mobile tab bar, and every globally-hosted overlay (add-to-playlist,
 * confirm, track-info, report-a-track, the update banner).
 *
 * Two things to read it with:
 *
 * - **`<main>` is empty on purpose.** The story router has no route table (the
 *   story URL is `/iframe.html`), so the outlet has nothing to activate. The
 *   subject here is the chrome around the page, not a page.
 * - **The header collapses below `md`.** On the mosaic home — which `/` is, and
 *   which is the URL a story sits at — every control in the header is already
 *   `hidden md:*`, so it would be a dead brand row eating a strip of a
 *   full-bleed surface (`headerDisplayClass`). Switch the Viewport global to
 *   Mobile to see that, and the tab bar that replaces it.
 *
 * `ngOnInit` starts the shell's own hydration — likes, recommendation
 * exclusions, in-flight acquisitions, the transfer poll — which the fixture
 * interceptor answers. The one thing it cannot answer is the live
 * `/api/library/events` SSE stream, because an `EventSource` is not
 * `HttpClient`; `StoryState.liveEvents` leaves it closed so the story reaches
 * no network at all.
 *
 * That hydration is also why the download badge is **not** storied here: the
 * transfer poll `ngOnInit` starts overwrites the seeded job signals with the
 * fixture's empty feeds within a tick. `bottom-nav`, which polls nothing,
 * carries that axis.
 */
const meta: Meta<LayoutComponent> = {
  title: 'Components/Layout',
  component: LayoutComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<LayoutComponent>;

/** Stories differ only by injected state, so each declares its own providers. */
const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [LayoutComponent] }),
  ],
});

const queue = demoTracks.slice(1, 4);

/**
 * Nothing loaded: the mini-player has translated itself off-screen and
 * `<main>`'s bottom padding shrinks to clear only the tab bar
 * (`mainBottomPadClass`).
 */
export const Idle: Story = { ...withState({}) };

/** A track playing: the bar is up, and `<main>` reserves room for it. */
export const Playing: Story = {
  ...withState({ currentTrack: demoTrack, isPlaying: true, queue, restoredTime: 47 }),
};

/** The same shell while the stream is still waiting on its first byte. */
export const Buffering: Story = {
  ...withState({
    currentTrack: demoTrack,
    isPlaying: true,
    queue,
    buffering: true,
    audioTransport: 'stalled',
  }),
};

/**
 * No network. The banner under the header is driven by `SetupService.isOffline()`,
 * which folds in `NetworkStatusService` — so it appears on a live connectivity
 * change, not only at boot, and needs no failed request to raise it.
 */
export const Offline: Story = {
  ...withState({ currentTrack: demoTrack, isPlaying: false, queue, offline: true }),
};
