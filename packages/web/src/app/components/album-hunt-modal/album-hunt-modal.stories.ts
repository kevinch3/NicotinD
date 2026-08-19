import { Component, effect, input, viewChild } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { AlbumHuntModalComponent } from './album-hunt-modal.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { DiscographyAlbum, FolderCandidate } from '../../services/api/api-types';

type State = 'searching' | 'results' | 'error' | 'already-complete' | 'already-downloading';

const ALBUM: DiscographyAlbum = {
  lidarrId: 1,
  foreignAlbumId: 'mbid-static-bloom',
  title: 'Static Bloom',
  releaseDate: '2025-04-11',
  albumType: 'Album',
  secondaryTypes: [],
  totalTracks: 3,
  localTrackCount: 0,
  status: 'missing',
  tracks: [
    { lidarrId: 11, title: 'Opening Static', trackNumber: '1', duration: 214_000, hasFile: false },
    { lidarrId: 12, title: 'Half Light', trackNumber: '2', duration: 198_000, hasFile: false },
    { lidarrId: 13, title: 'Rain On Tin', trackNumber: '3', duration: 231_000, hasFile: false },
  ],
};

const file = (name: string, size: number) => ({ filename: name, size, bitRate: 320 });

const candidate = (over: Partial<FolderCandidate>): FolderCandidate => ({
  directory: '@@music\\Nocturnal Signal\\Static Bloom (2025) [FLAC]',
  username: 'peer-one',
  files: [file('01.flac', 38_112_000), file('02.flac', 41_820_000), file('03.flac', 36_004_000)],
  matchedTracks: 3,
  totalTracks: 3,
  matchPct: 100,
  format: 'FLAC',
  estimatedSizeMb: 110,
  isLive: false,
  freeUploadSlots: 2,
  queueLength: 0,
  uploadSpeed: 1_400_000,
  ...over,
});

/**
 * Host wrapper: every state the modal can be in is a public settable signal, so
 * a story sets the outcome directly rather than driving a real hunt (which
 * needs slskd, a peer, and time).
 */
@Component({
  selector: 'app-album-hunt-probe',
  standalone: true,
  imports: [AlbumHuntModalComponent],
  template: `<app-album-hunt-modal [album]="album" artistName="Nocturnal Signal" />`,
})
class AlbumHuntProbeComponent {
  readonly album = ALBUM;
  readonly state = input<State>('results');
  readonly candidates = input<FolderCandidate[]>([]);
  readonly errorMsg = input('');
  readonly rateLimited = input(false);
  private readonly modal = viewChild(AlbumHuntModalComponent);

  constructor() {
    effect(() => {
      const m = this.modal();
      if (!m) return;
      m.candidates.set(this.candidates());
      m.totalTracks.set(ALBUM.totalTracks);
      m.errorMsg.set(this.errorMsg());
      m.rateLimited.set(this.rateLimited());
      m.state.set(this.state());
    });
  }
}

/**
 * The album hunt: search a source for folders containing this album, rank them,
 * and take the best one.
 *
 * The ranking is the interesting part. `matchPct` is **recall-only by design** —
 * all three of its consumers ask "is the whole album here?" — so it cannot tell
 * a clean rip from a whole-discography dump that happens to contain every
 * track. Both score 100%. `compareCandidates` therefore demotes a bloated
 * folder right after the match bucket, ahead of peer health, and tiebreaks on
 * per-track rather than total size (issue #271, where the old total-size
 * tiebreak actively preferred the dump).
 */
const meta: Meta<AlbumHuntProbeComponent> = {
  title: 'Components/AlbumHuntModal',
  component: AlbumHuntProbeComponent,
  decorators: [
    applicationConfig({ providers: storyProviders({ role: 'user' }) }),
    moduleMetadata({ imports: [AlbumHuntProbeComponent] }),
  ],
};
export default meta;

type Story = StoryObj<AlbumHuntProbeComponent>;

/** Two-phase progress: the plain query, then the skewed variants. */
export const Searching: Story = { args: { state: 'searching' } };

/**
 * Best match leading. The clean FLAC rip is first; the dump below it matches
 * every track too, which is exactly why match percentage alone cannot order
 * this list.
 */
export const BestMatchLeading: Story = {
  args: {
    state: 'results',
    candidates: [
      candidate({}),
      candidate({
        directory: '@@dump\\Discografia Completa Nocturnal Signal',
        username: 'peer-two',
        format: 'MP3 320',
        estimatedSizeMb: 1_840,
      }),
      candidate({
        directory: '@@shared\\Live\\Nocturnal Signal - Roskilde 2025',
        username: 'peer-three',
        matchedTracks: 2,
        matchPct: 66,
        format: 'MP3 V0',
        isLive: true,
        estimatedSizeMb: 74,
        freeUploadSlots: 0,
        queueLength: 12,
      }),
    ],
  },
};

/** Zero folders matched — the per-track fallback is what the user reaches for next. */
export const NoResults: Story = { args: { state: 'results', candidates: [] } };

/**
 * The source throttled the search burst (slskd 429), so the hunt may be
 * incomplete. Deliberately *not* reported as "no results": the modal keeps
 * trying, because reporting an empty hunt here would be a lie about the library.
 */
export const RateLimited: Story = {
  args: { state: 'results', candidates: [], rateLimited: true },
};

/**
 * **The behaviour worth pinning.** Already having the album is a *positive*
 * outcome, not an error — it renders as a green confirmation, because the user
 * asked for the album and the album is there. Reporting it red would train
 * people to ignore red.
 */
export const AlreadyHaveIt: Story = { args: { state: 'already-complete' } };

/** Same idea for an in-flight download: idempotent, and a notice rather than a failure. */
export const AlreadyDownloading: Story = { args: { state: 'already-downloading' } };

/** A genuine failure — the source was unreachable. */
export const HuntFailed: Story = {
  args: { state: 'error', errorMsg: 'slskd is not reachable' },
};
