import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { ReviewInboxComponent } from './review-inbox.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import type { ReviewQueueAlbum } from '../../services/api/api-types';

/**
 * The download-triage inbox: albums that cleared quarantine's required steps
 * but are held for a curator's approve / discard / fix decision (issue #411,
 * opt-in via the `holdForReview` processing setting).
 *
 * **Self-gating.** `visible()` is `canCurate() && queue().length > 0`, so it
 * renders *nothing* for a non-curator or an empty queue — that is what lets the
 * Downloads page mount it unconditionally. The two blank stories below are the
 * behaviour, not a broken fixture.
 */
const meta: Meta<ReviewInboxComponent> = {
  title: 'Components/ReviewInbox',
  component: ReviewInboxComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<ReviewInboxComponent>;

const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [ReviewInboxComponent] }),
  ],
});

/** Everything analysed — the straightforward approve-or-discard case. */
const CLEAN: ReviewQueueAlbum = {
  albumId: 'alb-clean',
  albumTitle: 'Static Bloom',
  albumArtist: 'Nocturnal Signal',
  year: 2025,
  songs: [
    {
      id: 's1',
      title: 'Opening Static',
      track: 1,
      steps: {
        download: 'done',
        bpm: 'done',
        key: 'done',
        energy: 'done',
        genre: 'done',
        mood: 'done',
      },
    },
    {
      id: 's2',
      title: 'Half Light',
      track: 2,
      steps: {
        download: 'done',
        bpm: 'done',
        key: 'done',
        energy: 'done',
        genre: 'done',
        mood: 'done',
      },
    },
  ],
};

/**
 * The mixed case, which is the normal one. `skipped` is not a failure: a step
 * is skipped when it is off, unavailable, or permanently failed after N
 * attempts — the ledger that stops one corrupt file blocking a landing forever.
 * It has to read differently from `pending`, which simply has not run yet.
 */
const MIXED: ReviewQueueAlbum = {
  albumId: 'alb-mixed',
  albumTitle: 'Field Recordings',
  albumArtist: 'Various Artists',
  year: null,
  songs: [
    {
      id: 's3',
      title: 'Untitled Take',
      track: null,
      steps: {
        download: 'done',
        bpm: 'done',
        key: 'pending',
        energy: 'done',
        genre: 'skipped',
        mood: 'pending',
      },
    },
    {
      id: 's4',
      title: 'Rain On Tin',
      track: 4,
      steps: {
        download: 'done',
        bpm: 'skipped',
        key: 'skipped',
        energy: 'done',
        genre: 'done',
        mood: 'skipped',
      },
    },
  ],
};

/** One album waiting on a decision. */
export const OneAlbum: Story = { ...withState({ role: 'admin', reviewQueue: [CLEAN] }) };

/** A backlog, with a fully-analysed album beside a partly-skipped one. */
export const MixedStepStates: Story = {
  ...withState({ role: 'admin', reviewQueue: [CLEAN, MIXED] }),
};

/**
 * Empty queue — renders nothing at all. Deliberate: the Downloads page mounts
 * this unconditionally and the inbox decides for itself whether it belongs on
 * screen, so "no queue" must not leave an empty heading behind.
 */
export const EmptyQueueRendersNothing: Story = {
  ...withState({ role: 'admin', reviewQueue: [] }),
};

/**
 * A listener with a non-empty queue still sees nothing. The gate is
 * `canCurate()`, and it is enforced server-side too — this is the declutter
 * half, not the security half.
 */
export const ListenerSeesNothing: Story = {
  ...withState({ role: 'listener', reviewQueue: [CLEAN] }),
};
