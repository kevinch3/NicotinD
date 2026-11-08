import { inject, provideAppInitializer } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { PageBackService } from '../../services/page-back.service';
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
 * - **The header collapses below `md`** unless the page has a back target
 *   (#1770): every other control in it is `hidden md:*`, so without the arrow
 *   it is a dead brand row (`headerDisplayClass`). Switch the Viewport global
 *   to Mobile to see that, and the tab bar that replaces it; `WithBackTarget`
 *   shows the bar a detail page gets.
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
 * publishes a 0px height, so `<main>`'s bottom padding clears only the tab bar
 * (`MAIN_BOTTOM_PAD_CLASS`).
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

/**
 * A detail page's shell: the page registered a back target, so the bar shows
 * the arrow beside the logo at every width — and, on a phone, shows at all.
 */
export const WithBackTarget: Story = {
  decorators: [
    applicationConfig({
      providers: [
        ...storyProviders({}),
        provideAppInitializer(() => inject(PageBackService).register(() => {})),
      ],
    }),
    moduleMetadata({ imports: [LayoutComponent] }),
  ],
};
