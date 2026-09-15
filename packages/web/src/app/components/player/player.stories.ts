import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { PlayerComponent } from './player.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import { demoTrack, demoTracks } from '../../../stories/support/fixtures';

/**
 * The mini-player, and the playback engine under it.
 *
 * **The bar is not the component.** `<app-player>` owns the two `<audio>`
 * elements — buffering, the transcode fallback, false-ended recovery, the stall
 * watchdog and the OS media session all live here — and the TV build mounts it
 * *headless*, chrome and all gated off, precisely so the engine survives a
 * surface that has no bar (see the class comment and docs/tv-ux.md). Storybook
 * cannot show that half: the fork is `isTvBuild()`, a build-time flag, so the
 * **TV build toolbar global does not collapse this story** — it only stamps
 * `html.tv-build`, which this component deliberately does not read.
 *
 * These stories run the component's real load effects. What is faked is the one
 * transport an `HttpInterceptorFn` cannot reach — the element's own resource
 * load — which `story-audio.ts` answers with decodable silence, or with a
 * stream that never delivers a byte for the buffering case.
 */
const meta: Meta<PlayerComponent> = {
  title: 'Components/Player',
  component: PlayerComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<PlayerComponent>;

/** Stories differ only by injected state, so each declares its own providers. */
const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [PlayerComponent] }),
  ],
});

const queue = demoTracks.slice(1, 4);

/**
 * A track is loaded and paused — where the bar sits for most of its life.
 * With no track at all it translates itself off-screen entirely
 * (`miniPlayerSlideClass`); that state is visible in the `Layout` stories,
 * which render the shell around it.
 */
export const Idle: Story = {
  ...withState({ currentTrack: demoTrack, isPlaying: false, queue, restoredTime: 47 }),
};

/**
 * Playing, parked mid-track. The elapsed time and the seek bar are driven by
 * the real element through `requestAnimationFrame`, not by a seeded number, so
 * this story ticks.
 */
export const Playing: Story = {
  ...withState({ currentTrack: demoTrack, isPlaying: true, queue, restoredTime: 47 }),
};

/**
 * Waiting on bytes. Seeding `buffering` is not enough on its own — the
 * component clears it the moment the element says it can play — so the story
 * hands the element a stream that stays at `HAVE_NOTHING`. That is also why
 * this is the one story that reproduces a real stall: left open for 20 s it
 * runs `STREAM_STALL_TIMEOUT_MS` and the dead-stream recovery behind it.
 */
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
 * The device has no network and this track was never downloaded, so there is
 * nothing to point `<audio>` at: `stopForOffline` parks the element rather than
 * leaving a spinner that can never resolve, and the listener gets a toast (the
 * outlet lives in the app shell, not here). The bar keeps the track it had.
 */
export const Offline: Story = {
  ...withState({ currentTrack: demoTrack, isPlaying: false, queue, offline: true }),
};
