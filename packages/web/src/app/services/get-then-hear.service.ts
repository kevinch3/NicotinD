/**
 * Get, then hear it (#1294): a track got from search joins this device's queue
 * by itself once its acquisition job lands, and the listener is told once.
 *
 * `remember()` is called by the search page with the job id the Get produced;
 * the intent is kept per device in localStorage so a reload between Get and
 * landing does not lose it. `start()` (the shell calls it) watches the job
 * feed `TransferService` already polls — a landing pushes `job.changed`, which
 * re-polls it at once — and settles every intent whose job has closed:
 *
 * - `done`: fetch the job's own landed songs (`GET /api/downloads/jobs/:id/songs`,
 *   album order), enqueue them once — next for a single track, at the end for
 *   more — and show one toast whose action jumps to the first. With nothing
 *   loaded, the queue is left alone and the action plays the landed set
 *   instead (the same verb as an album's Play).
 * - `failed` / `superseded`, or a job that lands no playable song: dropped
 *   silently — no toast, no queue change.
 *
 * Once only: an intent is removed from storage *before* its songs are fetched,
 * so a reload or a second feed tick mid-fetch cannot enqueue it twice. A fetch
 * that fails loses the enqueue rather than risking a duplicate.
 *
 * The enqueue is local to this device's `PlayerService`, the same as the song
 * menu's Play next: when this device is a remote-playback controller, its local
 * queue is the session it drives, never the active output's own. See
 * docs/get-then-hear.md.
 */
import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AcquisitionJobView } from '@nicotind/core';
import { DownloadsApiService } from './api/downloads-api.service';
import { PlayerService, type Track } from './player.service';
import { ToastService } from './toast.service';
import { TransferService } from './transfer.service';
import { TranslateService } from './translate.service';
import { UserPreferencesService } from './user-preferences.service';
import { toTrack } from '../lib/track-utils';

/** Where a landed set goes in a queue that is already playing. */
export type GetMode = 'next' | 'later';

export interface GetIntent {
  jobId: string;
  /** Absent for a Get whose size is unknown until it lands (a link). */
  mode?: GetMode;
  /** When Get was pressed (epoch ms) — the stale prune's clock. */
  at: number;
}

export const GET_INTENTS_KEY = 'nicotind-get-intents';
/** An intent whose job the feed no longer shows is dropped after this long. */
export const GET_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const TOAST_SECONDS = 8;

/** A single track jumps the queue; an album or a folder joins its end. */
export function modeForFileCount(count: number): GetMode {
  return count === 1 ? 'next' : 'later';
}

function readIntents(): Record<string, GetIntent> {
  try {
    const raw = localStorage.getItem(GET_INTENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, GetIntent>) : {};
  } catch {
    return {};
  }
}

function writeIntents(intents: Record<string, GetIntent>): void {
  try {
    if (Object.keys(intents).length === 0) localStorage.removeItem(GET_INTENTS_KEY);
    else localStorage.setItem(GET_INTENTS_KEY, JSON.stringify(intents));
  } catch {
    /* storage unavailable — the intent lives only as long as this tab */
  }
}

@Injectable({ providedIn: 'root' })
export class GetThenHearService {
  private readonly injector = inject(Injector);
  private readonly downloadsApi = inject(DownloadsApiService);
  private readonly player = inject(PlayerService);
  private readonly toast = inject(ToastService);
  private readonly transfers = inject(TransferService);
  private readonly i18n = inject(TranslateService);
  private readonly prefs = inject(UserPreferencesService);
  /** Jobs this tab already settled — a second guard behind the storage claim. */
  private readonly settled = new Set<string>();
  private started = false;

  /** Watch the job feed for as long as the app lives. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    effect(
      () => {
        const jobs = this.transfers.acquisitionJobs();
        untracked(() => this.reconcile(jobs));
      },
      { injector: this.injector },
    );
  }

  /** Record that this device pressed Get on a job. No-op when opted out. */
  remember(jobId: string | null | undefined, mode?: GetMode, now = Date.now()): void {
    if (!jobId || !this.enabled()) return;
    const intents = readIntents();
    intents[jobId] = { jobId, ...(mode ? { mode } : {}), at: now };
    writeIntents(intents);
  }

  /** Settle every intent whose job the feed shows closed; prune the stale. */
  reconcile(jobs: readonly AcquisitionJobView[], now = Date.now()): void {
    const intents = readIntents();
    const pending = Object.values(intents);
    if (pending.length === 0) return;
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const landed: GetIntent[] = [];
    for (const intent of pending) {
      const job = byId.get(intent.jobId);
      if (!job) {
        if (!(now - intent.at <= GET_INTENT_TTL_MS)) delete intents[intent.jobId];
        continue;
      }
      if (job.state === 'active') continue;
      delete intents[intent.jobId];
      if (job.state === 'done' && !this.settled.has(intent.jobId)) landed.push(intent);
      this.settled.add(intent.jobId);
    }
    writeIntents(intents);
    for (const intent of landed) void this.land(intent);
  }

  private enabled(): boolean {
    return this.prefs.queueAcquired();
  }

  private async land(intent: GetIntent): Promise<void> {
    if (!this.enabled()) return;
    let tracks: Track[];
    try {
      const res = await firstValueFrom(this.downloadsApi.getJobSongs(intent.jobId));
      tracks = res.songs.map((s) => ({ ...toTrack(s), queuedBy: 'user' as const }));
    } catch {
      return;
    }
    if (tracks.length === 0) return;
    const first = tracks[0]!;
    const one = tracks.length === 1;
    const params = { title: first.title, count: tracks.length };

    if (!this.player.currentTrack()) {
      this.announce(
        this.i18n.t(one ? 'getThenHear.readyOne' : 'getThenHear.readyOther', params),
        'getThenHear.play',
        () => this.player.playWithContext(tracks, 0, { type: 'adhoc', name: first.album }),
      );
      return;
    }

    const mode = intent.mode ?? modeForFileCount(tracks.length);
    if (mode === 'next') tracks.forEach((t, i) => this.player.insertInQueue(i, t));
    else for (const t of tracks) this.player.addToQueue(t);
    const key =
      mode === 'next'
        ? one
          ? 'getThenHear.queuedNextOne'
          : 'getThenHear.queuedNextOther'
        : one
          ? 'getThenHear.queuedLaterOne'
          : 'getThenHear.queuedLaterOther';
    this.announce(this.i18n.t(key, params), 'getThenHear.playNow', () => {
      // The listener may have reordered since; jump to wherever it is now.
      const index = this.player.queue().findIndex((t) => t.id === first.id);
      if (index >= 0) this.player.jumpToQueueIndex(index);
    });
  }

  private announce(message: string, actionKey: string, act: () => void): void {
    const id = this.toast.show({
      message,
      kind: 'success',
      duration: TOAST_SECONDS,
      actions: [
        {
          label: this.i18n.t(actionKey),
          callback: () => {
            act();
            this.toast.dismiss(id);
          },
        },
      ],
    });
  }
}
