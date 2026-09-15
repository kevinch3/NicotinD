import { Component, effect, input, viewChild } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { NowPlayingComponent } from './now-playing.component';
import { PlayerComponent } from '../player/player.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import { demoTrack, demoTracks } from '../../../stories/support/fixtures';

/**
 * Host wrapper that picks the panel and mounts the engine.
 *
 * `activePanel` is component-internal state restored from per-device storage,
 * not an input, so a story reaches it through a `viewChild` — the same shape
 * `folder-browser` uses for its seeded browse result. The signal is written
 * directly rather than through `setActivePanel()`, which persists: one story's
 * choice would otherwise be the next story's restored default for the rest of
 * the browser profile's life.
 *
 * `<app-player />` is here for the same reason the shell always mounts it
 * beside the sheet: the sheet renders position, length and the buffering
 * spinner out of `PlayerService`, and what writes them is the `<audio>` engine
 * inside the player. A sheet-only story would show 0:00 over a zero-length
 * seek bar and could never reach a real load. The bar itself is covered — the
 * sheet is `fixed inset-0 z-[60]`, the bar `z-50`.
 */
@Component({
  selector: 'app-now-playing-probe',
  standalone: true,
  imports: [NowPlayingComponent, PlayerComponent],
  template: `<app-player /><app-now-playing />`,
})
class NowPlayingProbeComponent {
  readonly panel = input<'queue' | 'lyrics'>('queue');
  private readonly sheet = viewChild(NowPlayingComponent);

  constructor() {
    effect(() => {
      const sheet = this.sheet();
      if (sheet) sheet.activePanel.set(this.panel());
    });
  }
}

/**
 * The full-screen Now Playing sheet: cover, transport, and one panel that is
 * either the queue or the lyrics.
 *
 * Reading these stories:
 *
 * - **The sheet is never unmounted**, only translated below the viewport, so
 *   every story opens it (`StoryState.nowPlayingOpen`). Without that the canvas
 *   is off-screen and still passes the render gate.
 * - **Below `lg` the panel stacks under the cover; at `lg` it becomes a fixed
 *   380px column** beside a centred cover/transport. Flip the Viewport global,
 *   or read `TwoColumnDesktop`.
 * - **The TV build global forks this component.** Unlike the player bar, the
 *   10-foot treatment here keys off `isTvUi()` — the `html.tv-build` class the
 *   global stamps — so turning it on really does render the TV sheet (blurred
 *   cover backdrop, bottom transport, Next-up chip in place of the panel).
 *
 * The seek bar is the waveform strip rather than the plain one because the
 * fixture answers `GET /api/peaks/:id`; the plain fallback is what a track with
 * no analysed waveform gets.
 */
const meta: Meta<NowPlayingProbeComponent> = {
  title: 'Components/NowPlaying',
  component: NowPlayingProbeComponent,
  tags: ['autodocs'],
  parameters: {
    viewport: { defaultViewport: 'mobile' },
    docs: {
      description: {
        component:
          'The full-screen Now Playing sheet — cover, transport, and a queue/lyrics panel. Rendered through a host wrapper that picks the panel, because the panel choice is component-internal state restored from per-device storage rather than an input.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<NowPlayingProbeComponent>;

const withState = (state: StoryState, panel: 'queue' | 'lyrics' = 'queue') => ({
  args: { panel },
  decorators: [
    applicationConfig({ providers: storyProviders({ nowPlayingOpen: true, ...state }) }),
    moduleMetadata({ imports: [NowPlayingProbeComponent] }),
  ],
});

const queue = demoTracks.slice(1, 5);
const loaded = { currentTrack: demoTrack, queue, restoredTime: 47 };

/** Paused on a loaded track, queue panel — the sheet's resting state. */
export const Idle: Story = { ...withState({ ...loaded, isPlaying: false }) };

/**
 * Playing. The elapsed time comes from the real audio element, so this story
 * ticks; the queue below is the live `PlayerService.queue`, which is what the
 * rows are reordered and removed from.
 */
export const Playing: Story = { ...withState({ ...loaded, isPlaying: true }) };

/**
 * Waiting on bytes: the transport shows the spinner in place of the play
 * state. Held there by a stream that never delivers a byte — seeding
 * `buffering` alone would be cleared by the element the moment it could play.
 */
export const Buffering: Story = {
  ...withState({ ...loaded, isPlaying: true, buffering: true, audioTransport: 'stalled' }),
};

/**
 * No network. The sheet has **no offline affordance of its own** — the banner
 * lives in the app shell and the refusal arrives as a toast — so what this
 * story documents is the state it is left in: the track it had, and a player
 * behind it that has parked the element rather than spin on a stream that
 * cannot arrive (`stopForOffline`).
 */
export const Offline: Story = {
  ...withState({ ...loaded, isPlaying: false, offline: true }),
};

/**
 * The Lyrics panel, on synced LRC. The active line is chosen from the sheet's
 * *display* time — which follows a remote session when the audio is elsewhere,
 * not just the local element — so parking playback mid-track is what puts the
 * highlight somewhere other than the first line.
 */
export const LyricsPanel: Story = {
  ...withState({ ...loaded, isPlaying: true }, 'lyrics'),
};

/**
 * At `lg` the sheet is two columns: cover and transport centred on the left,
 * the panel a fixed 380px column with its own border on the right. The
 * drag-to-resize handle between them is `lg:hidden` — resizing is a phone
 * gesture, and there is nothing to reclaim here.
 */
export const TwoColumnDesktop: Story = {
  ...withState({ ...loaded, isPlaying: true }),
  parameters: { viewport: { defaultViewport: 'desktop' } },
};
