import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { PublicPollScenario, PublicPollView } from '../../../types/core';
import { ServerConfigService } from '../../services/server-config.service';
import { SeekBarComponent } from '../../components/seek-bar/seek-bar.component';
import { SkeletonComponent } from '../../components/skeleton/skeleton.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import {
  nextStep,
  pollFailureState,
  prevStep,
  ratedCount,
  voteKey,
  votesForScenario,
  type PollPageState,
  type PollStep,
  type PollVoteValue,
} from './poll-view.lib';
import { getRaterKey } from './rater-key';

/**
 * Public radio-evaluation poll wizard (docs/radio-eval-polls.md). Guard-less
 * like /share: an anonymous rater walks intro → one step per frozen scenario
 * (a fake Now Playing card + the engine's next-up suggestions, each rated 1–5
 * stars — thumbs on legacy binary polls — each playable via the short-lived
 * media JWT) → thanks. Votes POST per scenario on advance so an abandoned
 * session still contributes.
 *
 * The poll GET is idempotent — re-fetching refreshes the media JWT, which this
 * component does silently when it expires mid-session or an audio load fails.
 */
@Component({
  selector: 'app-poll-view',
  templateUrl: './poll-view.component.html',
  imports: [SeekBarComponent, SkeletonComponent, TranslatePipe],
})
export class PollViewComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private server = inject(ServerConfigService);

  readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audioEl');

  readonly state = signal<PollPageState>('loading');
  readonly view = signal<PublicPollView | null>(null);
  readonly step = signal<PollStep>('intro');
  readonly submitting = signal(false);
  readonly submitError = signal(false);
  readonly playbackFailed = signal(false);
  /** voteKey(scenario, candidate) → rating or verdict; local until the scenario advances. */
  readonly votes = signal<ReadonlyMap<string, PollVoteValue>>(new Map());
  readonly playingId = signal<string | null>(null);
  /** Playback clock of the shared <audio>, driving the playing row's seek bar. */
  readonly position = signal(0);
  private readonly mediaDuration = signal(0);

  /** Template loop for the stars5 rating row. */
  readonly stars = [1, 2, 3, 4, 5] as const;

  private token = '';
  private mediaJwt = '';
  private mediaJwtExpiresAt = 0;

  readonly scenario = computed<PublicPollScenario | null>(() => {
    const s = this.step();
    return typeof s === 'number' ? (this.view()?.scenarios[s] ?? null) : null;
  });
  readonly scenarioIndex = computed(() =>
    typeof this.step() === 'number' ? (this.step() as number) : -1,
  );
  readonly scenarioCount = computed(() => this.view()?.scenarios.length ?? 0);
  readonly voteScale = computed(() => this.view()?.poll.voteScale ?? 'binary');
  /** Seek-bar duration: the element's own once metadata loads, else the frozen
   *  track duration so the bar is usable from the first frame. */
  readonly playingDuration = computed(() => {
    const media = this.mediaDuration();
    if (media > 0) return media;
    const id = this.playingId();
    const sc = this.scenario();
    if (!id || !sc) return 0;
    if (sc.seed?.id === id) return sc.seed.duration;
    return sc.candidates.find((c) => c.id === id)?.duration ?? 0;
  });
  readonly currentRated = computed(() => {
    const sc = this.scenario();
    return sc ? ratedCount(sc, this.votes()) : 0;
  });

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    await this.load();
  }

  ngOnDestroy(): void {
    this.audioRef()?.nativeElement.pause();
  }

  private async load(): Promise<void> {
    try {
      const view = await firstValueFrom(
        this.http.get<PublicPollView>(`/api/radio-polls/public/${this.token}`),
      );
      this.view.set(view);
      this.mediaJwt = view.mediaJwt;
      this.mediaJwtExpiresAt = view.mediaJwtExpiresAt;
      this.state.set('active');
    } catch (err) {
      this.state.set(pollFailureState(err as { status?: number; error?: { code?: string } }));
    }
  }

  /** A fresh media JWT via the idempotent poll GET (never re-renders the wizard). */
  private async refreshMediaJwt(): Promise<void> {
    try {
      const view = await firstValueFrom(
        this.http.get<PublicPollView>(`/api/radio-polls/public/${this.token}`),
      );
      this.mediaJwt = view.mediaJwt;
      this.mediaJwtExpiresAt = view.mediaJwtExpiresAt;
    } catch {
      // Poll may have closed mid-session; playback simply stops working while
      // voting (already-loaded data) still submits or fails visibly.
    }
  }

  coverUrl(coverId: string): string {
    return this.server.apiUrl(`/api/cover/${coverId}?size=300&token=${this.mediaJwt}`);
  }

  vote(candidateId: string, value: PollVoteValue): void {
    const sc = this.scenario();
    if (!sc) return;
    const next = new Map(this.votes());
    next.set(voteKey(sc.id, candidateId), value);
    this.votes.set(next);
  }

  verdictFor(candidateId: string): PollVoteValue | null {
    const sc = this.scenario();
    return sc ? (this.votes().get(voteKey(sc.id, candidateId)) ?? null) : null;
  }

  /** The candidate's star rating, or 0 when unrated (fills stars 1..n). */
  ratingFor(candidateId: string): number {
    const value = this.verdictFor(candidateId);
    return typeof value === 'number' ? value : 0;
  }

  async togglePlay(trackId: string): Promise<void> {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    if (this.playingId() === trackId) {
      audio.pause();
      this.playingId.set(null);
      return;
    }
    if (Date.now() >= this.mediaJwtExpiresAt) await this.refreshMediaJwt();
    this.playbackFailed.set(false);
    this.position.set(0);
    this.mediaDuration.set(0);
    audio.src = this.server.streamUrl(trackId, this.mediaJwt);
    audio.load();
    try {
      await audio.play();
      this.playingId.set(trackId);
    } catch {
      await this.onAudioError(trackId);
    }
  }

  /** A failed load may just be an expired JWT — retry once with a fresh one.
   *  A deleted-since-freeze file stays a toastable failure, never a broken step. */
  private async onAudioError(trackId: string): Promise<void> {
    await this.refreshMediaJwt();
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    audio.src = this.server.streamUrl(trackId, this.mediaJwt);
    audio.load();
    try {
      await audio.play();
      this.playingId.set(trackId);
    } catch {
      this.playingId.set(null);
      this.playbackFailed.set(true);
    }
  }

  onEnded(): void {
    this.playingId.set(null);
    this.position.set(0);
  }

  onTimeUpdate(): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    this.position.set(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      this.mediaDuration.set(audio.duration);
    }
  }

  onSeek(seconds: number): void {
    const audio = this.audioRef()?.nativeElement;
    if (audio) audio.currentTime = seconds;
  }

  start(): void {
    this.step.set(nextStep('intro', this.scenarioCount()));
  }

  back(): void {
    this.stopAudio();
    this.step.set(prevStep(this.step()));
  }

  async next(): Promise<void> {
    const sc = this.scenario();
    if (!sc || this.submitting()) return;
    // Rating is optional (#798): a fully skipped scenario advances without
    // POSTing — the API rejects empty vote batches.
    const votes = votesForScenario(sc, this.votes());
    if (votes.length === 0) {
      this.stopAudio();
      this.submitError.set(false);
      this.step.set(nextStep(this.step(), this.scenarioCount()));
      return;
    }
    this.submitting.set(true);
    this.submitError.set(false);
    try {
      await firstValueFrom(
        this.http.post(`/api/radio-polls/public/${this.token}/votes`, {
          raterKey: getRaterKey(),
          votes,
        }),
      );
      this.stopAudio();
      this.step.set(nextStep(this.step(), this.scenarioCount()));
    } catch (err) {
      const failure = pollFailureState(err as { status?: number; error?: { code?: string } });
      if (failure === 'closed' || failure === 'expired') {
        this.state.set(failure);
      } else {
        this.submitError.set(true);
      }
    } finally {
      this.submitting.set(false);
    }
  }

  private stopAudio(): void {
    this.audioRef()?.nativeElement.pause();
    this.playingId.set(null);
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
