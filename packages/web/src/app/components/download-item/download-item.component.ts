import { Component, effect, input, output, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DownloadItem } from '../../lib/download-groups';
import type { FailureClass } from '@nicotind/core';
import { methodBadge } from '../../lib/acquisition-method';
import { resolveAlbumRoute, resolvePlaylistRoute } from '../../lib/route-utils';
import { currentAndNextTracks, trackBreakdown } from '../../lib/track-status';
import { formatQuality } from '../../lib/download-status';
import { formatBytes } from '../../lib/disk-usage';
import { PipelineStageBadgeComponent } from '../pipeline-stage-badge/pipeline-stage-badge.component';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';
import { timeAgo } from '../../lib/relative-time';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Layout-critical classes for the row, exported and *bound* (not hardcoded in
 * the template) so the long-text truncation contract is unit-testable — the JIT
 * vitest harness can't drive a required `input()` into a render, so the spec
 * asserts these constants instead, and the template can't drift from them.
 *
 * - Host: the grid item in the Downloads feed. Without `block` it stays inline
 *   and sizes to content; without `min-w-0` a grid item refuses to shrink below
 *   its content's max width — either way the inner `overflow-hidden` never clips.
 * - Title: a flex item, which defaults to `min-width: auto`, so `truncate` is
 *   inert without `min-w-0`. That missing class is what let a long URL overflow.
 */
export type DownloadTrack = NonNullable<DownloadItem['tracks']>[number];

/**
 * What actually landed for one track — "FLAC · 960k · 8 MB". Every field was
 * already recorded per item and none of it reached the drilldown, which could
 * say a track was `done` and nothing else (issue #991). Pure and exported
 * because the JIT vitest harness cannot construct the component (its
 * `input.required()` needs an injection context).
 */
export function trackDetail(track: DownloadTrack): string {
  const parts: string[] = [];
  if (track.audioFormat) parts.push(track.audioFormat.toUpperCase());
  if (track.bitRate) parts.push(`${track.bitRate}k`);
  if (track.sizeBytes) parts.push(formatBytes(track.sizeBytes));
  return parts.join(' · ');
}

export const DOWNLOAD_ITEM_HOST_CLASS = 'block min-w-0';

/** Per-instance suffix for `aria-controls` — the ids must be unique per document. */
let bodyIdSeq = 0;
function nextBodyId(): number {
  return (bodyIdSeq += 1);
}

/**
 * The card. A COLUMN (#1066): the expandable body is a sibling of the header
 * row, not a child of the header's text cell, so it spans the card's full
 * width. Under the old three-way row layout the body lived in the first flex
 * child and stopped short by the progress column plus the buttons — a track
 * list narrower than the card containing it.
 *
 * That shape also needed `items-start` to stop expansion dragging the progress
 * bar and buttons to the card's new vertical middle (issue #991). A column
 * cannot do that: the header row keeps its own height whatever the body does,
 * so the workaround is gone rather than merely unnecessary.
 */
export const DOWNLOAD_ITEM_CARD_CLASS =
  'flex flex-col px-3 md:px-4 py-3 rounded-lg bg-theme-surface/50 border border-theme min-w-0 overflow-hidden';
/** The always-visible row: disclosure, identity + meta, actions. */
export const DOWNLOAD_ITEM_HEADER_CLASS = 'flex items-start gap-2 md:gap-3 min-w-0';
/** The expanded body — full card width, which is the entire point of #1066. */
export const DOWNLOAD_ITEM_BODY_CLASS = 'mt-2 w-full min-w-0 space-y-1.5';
export const DOWNLOAD_ITEM_TITLE_CLASS = 'text-sm text-theme-primary truncate min-w-0';

/**
 * Whether the row should offer an "Open in Library" deep-link: only once the
 * download is complete *and* we know the destination album id (hunt / URL
 * acquire; direct non-hunt Soulseek downloads have no id, so no link). Exported
 * so the gating contract is unit-testable without rendering the component.
 */
export function canOpenInLibrary(item: DownloadItem): boolean {
  return item.stage === 'done' && !!item.albumId;
}

/**
 * Whether the row should offer an "Open playlist" deep-link: a playlist-
 * classified acquire job (Spotify playlist, YouTube playlist, archive.org
 * with `as=playlist`) that completed and generated a native playlist. Wins
 * over the album / multi-album openers when set — a playlist acquisition
 * almost always spans many albums, so the playlist id is the more useful
 * destination than any single album. Exported so the gating contract is
 * unit-testable without rendering the component.
 */
export function canOpenPlaylist(item: DownloadItem): boolean {
  return item.stage === 'done' && !!item.playlistId;
}

/**
 * Whether the row should offer a "View N albums" menu instead: a completed
 * job whose files landed in more than one album (Task 1's `destinationAlbums`
 * — `albumId` is null in this case, so `canOpenInLibrary` is already false).
 * Exported so the gating contract is unit-testable without rendering.
 */
export function hasMultipleDestinationAlbums(item: DownloadItem): boolean {
  return item.stage === 'done' && (item.destinationAlbums?.length ?? 0) > 1;
}

/**
 * Whether the row should show the "Now: / Next:" track lines: gated on the
 * job's overall `stage` being the active-downloading one, not merely on
 * `tracks` having a 'downloading' entry. Task 6 flagged that an archive.org
 * download failing mid-file can leave a track stuck at `status:
 * 'downloading'` forever (no 'failed' transition emitted), which would make
 * `currentAndNextTracks` report a stale "Now" even after the job's `stage`
 * moved to a terminal one — gating on `stage` here makes the block disappear
 * the moment the job leaves the in-flight state, regardless of what a stale
 * per-track array still says.
 *
 * Also requires `kind === 'acquire'`: slskd hunts download several tracks in
 * parallel from different peers, so multiple `tracks` entries can be
 * 'downloading' at once. `currentAndNextTracks` picks the LAST one as "Now",
 * which for slskd is an arbitrary, jumpy title rather than a meaningful
 * "current track" — so the block is suppressed for slskd-sourced rows even
 * though the field is still populated (harmless to keep threading it
 * through). URL-acquire backends (spotdl/yt-dlp/archive) download one track
 * at a time, so "last downloading" is meaningful there. Exported so it's
 * unit-testable without rendering, matching the convention of the gating
 * helpers above.
 */
export function canShowNowNext(item: DownloadItem): boolean {
  return item.kind === 'acquire' && item.stage === 'downloading';
}

/**
 * Cancel is underway for this row (#806): the request round-trip
 * (`requestInFlight`, component-local) or the server's durable
 * `cancelRequested` marker — instant feedback that also survives a reload.
 * Exported so the gating contract is unit-testable without rendering.
 */
export function isCancelPending(item: DownloadItem, requestInFlight: boolean): boolean {
  return requestInFlight || !!item.cancelRequested;
}

/**
 * Whether the "N tracks landed — Discard" line applies (#810). Tracks land in
 * the library the moment they are scanned, so a cancelled job that already
 * delivered some is a decision point: keep the partial album, or throw those
 * tracks away. The line is offered once the cancel has been carried out (the
 * job is no longer cancellable) and only while something actually landed.
 */
export function canShowPartialDiscard(item: DownloadItem): boolean {
  return (
    item.kind === 'network' &&
    !!item.jobId &&
    !!item.cancelRequested &&
    !item.canCancel &&
    (item.progress?.done ?? 0) > 0
  );
}

/**
 * One row in the unified Downloads feed. Renders the four facets the user asked
 * for — how (method badge), what stage, when (started), where (storage path,
 * tucked behind a toggle) — plus, once complete, an "Open in Library" deep-link
 * to the destination album, and retry / cancel / remove controls that emit to
 * the parent, which dispatches by `item.kind`.
 */
/**
 * How a failure class reads on a card. `unknown` says "unclear" rather than
 * naming a cause: under throttling the source's "no results" answer is
 * indistinguishable from the track genuinely being absent, so claiming either
 * would be a guess dressed as a fact.
 */
export function failureClassLabel(klass: FailureClass): string {
  return klass === 'transient' ? 'may work on retry' : 'reason unclear';
}

@Component({
  selector: 'app-download-item',
  standalone: true,
  imports: [PipelineStageBadgeComponent, RouterLink, MenuPanelComponent, TranslatePipe],
  host: { '[class]': 'hostClass' },
  templateUrl: './download-item.component.html',
})
export class DownloadItemComponent {
  readonly hostClass = DOWNLOAD_ITEM_HOST_CLASS;
  readonly cardClass = DOWNLOAD_ITEM_CARD_CLASS;
  readonly headerClass = DOWNLOAD_ITEM_HEADER_CLASS;
  readonly bodyClass = DOWNLOAD_ITEM_BODY_CLASS;
  readonly titleClass = DOWNLOAD_ITEM_TITLE_CLASS;

  readonly item = input.required<DownloadItem>();
  readonly retrying = input(false);
  /** True while the parent's cancel request is in flight (#806). */
  readonly cancelling = input(false);
  /** True while a re-source request for this card is in flight (#1065). */
  readonly resourcing = input(false);

  readonly retry = output<void>();
  readonly cancel = output<void>();
  readonly remove = output<void>();
  /** Discard the partial tracks this cancelled job landed (#810). */
  readonly discardPartial = output<void>();
  /** Take these titles to another peer (#1065); empty means "everything pending". */
  readonly resource = output<string[]>();

  readonly showPath = signal(false);
  /** One expansion for the whole card, replacing two independent `<details>`. */
  readonly expanded = signal(false);
  /** Distinct per instance so `aria-controls` points at THIS card's body. */
  readonly bodyId = `download-body-${nextBodyId()}`;

  /** Titles the user ticked for a re-source, by title (the server's key too). */
  readonly selected = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // A card is recycled across feed polls, and a selection made against one
    // download must never be carried into another. Keyed on the card identity,
    // not on the tracks: the same job legitimately re-reports its titles.
    let lastKey: string | null = null;
    effect(() => {
      const key = this.item().key;
      if (key !== lastKey) {
        lastKey = key;
        this.selected.set(new Set());
      }
    });
  }

  /** Template access to the pure label helper. */
  readonly failureLabel = failureClassLabel;

  readonly badge = computed(() => methodBadge(this.item().method));
  /** Gates the "N tracks landed — Discard" line on a cancelled partial (#810). */
  readonly showPartialDiscard = computed(() => canShowPartialDiscard(this.item()));
  /** Compact "· FLAC · 1411 kbps" / "· 320 kbps" chip text, '' when unknown. */
  readonly qualityLabel = computed(() => {
    const it = this.item();
    return formatQuality(it.bitrateKbps, it.audioFormat);
  });
  /** Whether to show the bitrate chip — empty string hides it. */
  readonly showQuality = computed(() => this.qualityLabel().length > 0);
  /** Whether to show the "Open in Library" deep-link on this row. */
  readonly canOpen = computed(() => canOpenInLibrary(this.item()));
  /** Whether to show the "Open playlist" deep-link (playlist-classified job). */
  readonly canOpenPlaylist = computed(() => canOpenPlaylist(this.item()));
  /** Deep-link target for the completed album ('/library' when the id is unknown). */
  readonly albumRoute = computed(() => resolveAlbumRoute(this.item().albumId));
  /** Deep-link target for the generated native playlist. */
  readonly playlistRoute = computed(() => resolvePlaylistRoute(this.item().playlistId));

  /** The destination albums to list in the "View N albums" menu, when shown. */
  readonly destinationAlbums = computed(() => this.item().destinationAlbums ?? []);

  /**
   * "0 of 0" is a placeholder presented as a measurement — the same shape as
   * the "Done 1 of 1" class #585 closed. While the source is still resolving
   * the link we have no denominator, so the count is suppressed rather than
   * guessed; the `resolving` badge carries the meaning instead (#711).
   */
  readonly showProgressCount = computed(() => {
    const item = this.item();
    if (!item.progress) return false;
    return item.stage !== 'resolving';
  });
  /** Whether to show the "View N albums" menu on this row. */
  /**
   * A denominator the source has not committed to is not a total — it is a
   * running tally of arrivals, and printing it makes progress run backwards as
   * it climbs (#990). `undefined` means "committed", so every lane that never
   * had this problem renders exactly as before.
   */
  readonly showTotal = computed(() => this.item().totalCommitted !== false);

  /** Percent is only honest against a committed denominator. */
  readonly showPercentBar = computed(() => this.item().percent !== undefined && this.showTotal());

  /** ...and when it is not, the bar says "moving" without claiming how far. */
  readonly showIndeterminateBar = computed(
    () => this.item().percent !== undefined && !this.showTotal(),
  );

  readonly showAlbumsMenu = computed(() => hasMultipleDestinationAlbums(this.item()));

  /** Whether the row shows the "Cancelling…" chip instead of the X (#806). */
  readonly cancelPending = computed(() => isCancelPending(this.item(), this.cancelling()));

  /** "Now: / Next:" track titles derived from this job's per-track statuses. */
  readonly nowNext = computed(() => currentAndNextTracks(this.item().tracks));
  /** Whether to render the "Now: / Next:" block on this row. */
  readonly showNowNext = computed(() => canShowNowNext(this.item()) && !!this.nowNext().current);

  /** Per-status tally behind the track disclosure; null when there are no tracks. */
  readonly breakdown = computed(() => trackBreakdown(this.item().tracks));
  /**
   * The disclosure is offered whenever we know the tracks — including for
   * slskd, which `canShowNowNext` suppresses. That suppression exists because
   * "the last downloading title" is arbitrary across parallel peers; a full
   * list has no such ambiguity, and slskd album hunts are exactly the jobs
   * whose per-track outcome the user cannot otherwise discover (#746).
   */
  readonly showTracks = computed(() => (this.breakdown()?.total ?? 0) > 0);

  /**
   * The peer column is redundant on a single-source job — "1 download is 1
   * addon" — but a slskd hunt genuinely spans several peers (a fallback wave,
   * a multi-disc release), and there the column is the only place that shows
   * which track came from where. So it is shown exactly when it is news.
   */
  readonly showTrackPeer = computed(() => (this.item().sources?.length ?? 0) > 1);

  readonly trackDetail = trackDetail;

  /**
   * Whether there is anything behind the disclosure. Without this the caret
   * appears on a card that expands to nothing — a control that lies about
   * having content.
   */
  readonly canExpand = computed(
    () =>
      (this.breakdown()?.total ?? 0) > 0 ||
      (this.item().sources?.length ?? 0) > 1 ||
      !!this.item().failures ||
      !!this.item().error ||
      !!this.item().storagePath,
  );

  /** The percent, inline in the meta line now that the bar carries no label. */
  readonly showPercent = computed(() => this.showPercentBar());

  /** How many tracks are ticked for a re-source. */
  readonly selectedCount = computed(() => this.selected().size);

  /**
   * A track can be handed to another peer only while it has not arrived. The
   * checkbox is absent — not disabled — on delivered rows: an unusable control
   * on two thirds of a tracklist is noise.
   */
  canSelect(track: DownloadTrack): boolean {
    return !!this.item().canResource && track.status !== 'done';
  }

  isSelected(track: DownloadTrack): boolean {
    return this.selected().has(track.title);
  }

  toggle(track: DownloadTrack): void {
    const next = new Set(this.selected());
    if (!next.delete(track.title)) next.add(track.title);
    this.selected.set(next);
  }

  /**
   * The ticked titles, handed to the picker as a REQUIREMENT on which peers to
   * offer — not as the set to acquire. Re-sourcing releases the stuck job, so
   * whoever is chosen is asked for everything still pending; ticking narrows
   * who is worth choosing, not what gets downloaded (#1069). Empty means any
   * peer holding some of it.
   */
  selectedOrAll(): string[] {
    return [...this.selected()];
  }

  startedAgo(): string {
    const at = this.item().startedAt;
    return at ? timeAgo(at) : '';
  }

  /** Deep-link target for one destination album row in the "View N albums" menu. */
  albumRouteFor(albumId: string): string[] {
    return resolveAlbumRoute(albumId);
  }
}
