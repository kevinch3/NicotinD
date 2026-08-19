import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { FeedbackDetailSheetComponent } from './feedback-detail-sheet.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import type { FeedbackSheetPayload } from '../../services/feedback-sheet.service';

/**
 * The grading sheet behind the 👎 on a hunt-feedback toast: "which folder was
 * actually the right match?"
 *
 * It is a globally-hosted overlay driven by `FeedbackSheetService.payload()`,
 * so it renders nothing until a payload is set — the stories seed one. See
 * docs/generation-feedback.md for why the durable half of this loop is an Admin
 * review queue rather than the toast: a 12s toast is a lossy surface, and prod
 * graded 0 of ~39 captures before that was fixed.
 */
const meta: Meta<FeedbackDetailSheetComponent> = {
  title: 'Components/FeedbackDetailSheet',
  component: FeedbackDetailSheetComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<FeedbackDetailSheetComponent>;

const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [FeedbackDetailSheetComponent] }),
  ],
});

/**
 * Candidates carry the real scoring signals a grader needs — `matchPct` and
 * format — because the judgement being captured is "did the recognizer rank
 * these correctly", not "does this folder exist".
 */
const PAYLOAD: FeedbackSheetPayload = {
  feedbackId: 42,
  artistName: 'C. Tangana',
  albumTitle: 'El Madrileño',
  candidates: [
    {
      username: 'peer-one',
      directory: '@@music\\C. Tangana\\El Madrileno (2021) [FLAC]',
      matchPct: 100,
      format: 'FLAC',
    },
    {
      username: 'peer-two',
      directory: '@@shared\\Latin\\C Tangana - El Madrileno',
      matchPct: 93,
      format: 'MP3 320',
    },
    {
      username: 'peer-three',
      directory: '@@dump\\Discografia Completa C. Tangana',
      matchPct: 100,
      format: 'MP3 V0',
    },
  ],
};

/** The ordinary case: several plausible folders, one of which is correct. */
export const WithCandidates: Story = { ...withState({ feedbackSheet: PAYLOAD }) };

/**
 * Two candidates tie at 100% `matchPct` — the third is a whole-discography dump
 * that happens to contain every track. `matchPct` is recall-only by design, so
 * it cannot separate them; this is exactly the case issue #271 fixed in the
 * ranker, and the case a human grader is most useful for.
 */
export const TiedOnMatchPct: Story = {
  ...withState({
    feedbackSheet: {
      ...PAYLOAD,
      candidates: PAYLOAD.candidates.filter((c) => c.matchPct === 100),
    },
  }),
};

/** A single candidate — "none of these" is still a valid grade. */
export const SingleCandidate: Story = {
  ...withState({ feedbackSheet: { ...PAYLOAD, candidates: [PAYLOAD.candidates[0]!] } }),
};
