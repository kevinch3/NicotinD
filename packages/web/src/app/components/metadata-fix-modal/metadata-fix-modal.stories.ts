import { Component, effect, input, viewChild } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { MetadataFixModalComponent } from './metadata-fix-modal.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { ReviewQueueAlbum } from '../../services/api/api-types';

type Failure = { kind: string; detail?: string };

/**
 * Host wrapper, because `identifyFailures` is component-internal state rather
 * than a service signal: it is populated by the identify call's response, and
 * a story needs to show the *result* without performing the call.
 *
 * Same pattern the directive stories use — the wrapper reaches the component
 * through `viewChild` and stays as thin as it can while reproducing real usage.
 */
@Component({
  selector: 'app-metadata-fix-probe',
  standalone: true,
  imports: [MetadataFixModalComponent],
  template: `
    <app-metadata-fix-modal
      albumId="alb-review"
      currentArtist="Nocturnal Signal"
      currentAlbum="Field Recordings"
      [reviewTracks]="tracks()"
    />
  `,
})
class MetadataFixProbeComponent {
  readonly failures = input<Record<string, Failure>>({});
  readonly tracks = input<ReviewQueueAlbum['songs']>([]);
  private readonly modal = viewChild(MetadataFixModalComponent);

  constructor() {
    effect(() => {
      const modal = this.modal();
      if (!modal) return;
      modal.identifyFailures.set(new Map(Object.entries(this.failures())));
    });
  }
}

/**
 * The metadata-fix modal in **review mode**, showing the typed AcoustID
 * identify failures (issue #414).
 *
 * The five kinds exist because they ask for **opposite curator actions**: a
 * `no-match` means the fingerprint is fine and the database simply has nothing
 * (retag by hand), while `fpcalc-missing` is a server misconfiguration and
 * `undecodable` is a broken file. Collapsing them into one "identify failed"
 * would tell a curator nothing about what to do next — which is why `no-match`
 * renders neutral and every other kind renders as an error.
 *
 * Criterion inherited from #472, where it was attributed to `review-inbox`;
 * that component renders processing steps and has no identify state.
 */
const meta: Meta<MetadataFixProbeComponent> = {
  title: 'Components/MetadataFixModal',
  component: MetadataFixProbeComponent,
  decorators: [
    applicationConfig({ providers: storyProviders({ role: 'admin' }) }),
    moduleMetadata({ imports: [MetadataFixProbeComponent] }),
  ],
};
export default meta;

type Story = StoryObj<MetadataFixProbeComponent>;

const track = (id: string, title: string, n: number): ReviewQueueAlbum['songs'][number] => ({
  id,
  title,
  track: n,
  steps: {
    download: 'done',
    bpm: 'done',
    key: 'done',
    energy: 'done',
    genre: 'done',
    mood: 'done',
  },
});

const TRACKS = [
  track('t1', 'Opening Static', 1),
  track('t2', 'Half Light', 2),
  track('t3', 'Rain On Tin', 3),
  track('t4', 'Untitled Take', 4),
  track('t5', 'Closing Time', 5),
];

/**
 * All five kinds at once — the comparison that makes the neutral-vs-error
 * split legible. A curator scanning this list should be able to tell "retag
 * this one by hand" from "fix the server" without reading the copy twice.
 */
export const AllIdentifyFailureKinds: Story = {
  args: {
    tracks: TRACKS,
    failures: {
      t1: { kind: 'no-match' },
      t2: { kind: 'fpcalc-missing' },
      t3: { kind: 'undecodable', detail: 'fpcalc: could not decode audio stream' },
      t4: { kind: 'source-error', detail: 'AcoustID responded 503' },
      t5: { kind: 'file-missing' },
    },
  },
};

/** The fingerprint worked; AcoustID simply has no entry. Neutral, not an error. */
export const NoMatch: Story = {
  args: { tracks: [TRACKS[0]!], failures: { t1: { kind: 'no-match' } } },
};

/** fpcalc is not installed — a server misconfiguration, not a file problem. */
export const FpcalcMissing: Story = {
  args: { tracks: [TRACKS[0]!], failures: { t1: { kind: 'fpcalc-missing' } } },
};

/** The file cannot be decoded. The fpcalc stderr tail rides in the tooltip. */
export const Undecodable: Story = {
  args: {
    tracks: [TRACKS[0]!],
    failures: { t1: { kind: 'undecodable', detail: 'fpcalc: could not decode audio stream' } },
  },
};

/** AcoustID itself failed — transient, so retrying is the right action. */
export const SourceError: Story = {
  args: {
    tracks: [TRACKS[0]!],
    failures: { t1: { kind: 'source-error', detail: 'AcoustID responded 503' } },
  },
};

/** The file is gone from disk — nothing to fingerprint. */
export const FileMissing: Story = {
  args: { tracks: [TRACKS[0]!], failures: { t1: { kind: 'file-missing' } } },
};
