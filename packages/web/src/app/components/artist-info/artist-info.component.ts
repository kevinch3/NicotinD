import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { formatArtistBio, isOverflowing, mergeArtistSources } from '../../lib/artist-bio';

/**
 * Inline artist bio + external links section (issue #195, polished in #213),
 * sourced from Discogs. Read-mostly display content — an inline section, not a
 * modal — with a curator-gated refresh action.
 *
 * The raw `profile` field is BBCode-ish and would render as garbage verbatim;
 * {@link formatArtistBio} cleans it on every render so existing rows reformat
 * without a refetch, and a future markup change can't leave rows stuck with
 * the old garbage.
 *
 * Three pieces of UX polish from issue #213:
 *  1. **Auto-fetch on first load.** When the parent reports `metaExists=false`
 *     (no `library_artist_meta` row at all — *not* the same as a tombstone)
 *     and the user can curate, the component silently fetches once. Never
 *     fires for a `manualOverride=true` row, never surfaces a toast on miss
 *     (that's the explicit Refresh's job), and never re-fires once the row
 *     exists (the server tombstones, so the next visit sees `metaExists=true`).
 *  2. **Sources behind a disclosure.** External URLs (`urls` + URLs extracted
 *     from the profile) are hidden under a "Sources (N)" button rather than
 *     displayed inline.
 *  3. **Show-more based on actual overflow.** The toggle's visibility is
 *     measured via `scrollHeight` vs `clientHeight` in a `ResizeObserver`,
 *     not a char count — so it never appears when there's nothing to expand
 *     (Britney example) and always appears when there is (ABBA example).
 */
@Component({
  selector: 'app-artist-info',
  standalone: true,
  templateUrl: './artist-info.component.html',
})
export class ArtistInfoComponent implements AfterViewInit, OnDestroy {
  private api = inject(LibraryApiService);
  private toasts = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly artistId = input.required<string>();
  readonly bio = input<string | null>(null);
  readonly urls = input<string[]>([]);
  /**
   * Whether a `library_artist_meta` row exists. `false` ⇒ *never fetched*;
   * the auto-fetch path uses this to fire a one-shot on first load. A row
   * with `bio=null && manualOverride=false` (a tombstoned confident miss)
   * has `metaExists=true` and must NOT trigger a re-fetch.
   */
  readonly metaExists = input(true);
  /** A curator's hand-edit (`source='user', manual_override=1`). Auto-fetch
   *  must never touch this — the curator wins. */
  readonly manualOverride = input(false);
  /** Emitted after a successful refresh so the parent page can update its own signal. */
  readonly updated = output<{ bio: string | null; urls: string[] }>();

  readonly shownBio = signal<string | null | undefined>(undefined);
  readonly shownUrls = signal<string[] | undefined>(undefined);
  readonly refreshing = signal(false);
  readonly expanded = signal(false);
  readonly sourcesOpen = signal(false);
  /** True when the bio's collapsed height clips its content. Driven by
   *  the `ResizeObserver` in {@link measureOverflow} — never a char count. */
  readonly hasOverflow = signal(false);

  private readonly bioEl = viewChild<ElementRef<HTMLParagraphElement>>('bio');
  private resizeObserver?: ResizeObserver;

  constructor() {
    // Set up a `ResizeObserver` on the bio element as soon as it appears
    // so viewport/font/content changes re-trigger the measurement.
    // (The measurement itself is the `ResizeObserver` callback — no
    // separate effect — because any effect that calls `measureOverflow`
    // would overwrite a manually-set `hasOverflow` signal during change
    // detection, which makes the template-binding tests impossible.)
    effect(() => {
      const el = this.bioEl()?.nativeElement;
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
      if (!el) return;
      this.resizeObserver = new ResizeObserver(() => this.measureOverflow());
      this.resizeObserver.observe(el);
    });

    // Auto-fetch on first load (issue #213 part 1). Fires once, only when
    // no row exists at all, and only for users who can curate. Silently
    // degrades on any outcome (no toasts — that's the explicit Refresh's
    // job). The `untracked` reads inside the `if` are deliberate: the
    // auto-fetch is a one-shot on mount, not a response to reactive input
    // changes after that.
    effect(() => {
      const bio = this.effectiveBio();
      const metaExists = this.metaExists();
      const override = this.manualOverride();
      const canCurate = this.auth.canCurate();
      if (bio || metaExists || override || !canCurate) return;
      untracked(() => this.autoFetch());
    });
  }

  ngAfterViewInit(): void {
    // The `ResizeObserver` may not fire on the *initial* layout in every
    // browser, so measure explicitly once the view is up. If the bio
    // element doesn't exist yet (deferred bio), the no-op path in
    // `measureOverflow` handles it and the observer will pick up the
    // first real layout change.
    this.measureOverflow();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  /** Falls back to the input until a refresh overrides it locally. */
  effectiveBio(): string | null {
    const local = this.shownBio();
    return local !== undefined ? local : this.bio();
  }

  effectiveUrls(): string[] {
    const local = this.shownUrls();
    return local !== undefined ? local : this.urls();
  }

  /** Bio with the Discogs markup stripped, plus bare URLs that were trailing
   *  the profile (they belong in the Sources list, not inline). */
  formatted(): { bio: string | null; urls: string[] } {
    return formatArtistBio(this.effectiveBio());
  }

  /** Combined, deduped sources list: API `urls` ∪ URLs extracted from the profile. */
  allSources(): string[] {
    return mergeArtistSources(this.effectiveUrls(), this.formatted().urls);
  }

  refresh(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.api.refreshArtistInfo(this.artistId()).subscribe({
      next: (r) => {
        this.refreshing.set(false);
        this.shownBio.set(r.bio);
        this.shownUrls.set(r.urls);
        this.updated.emit(r);
        // The bio appearing inline is its own confirmation — no success toast.
        // A clean "no info found" response is still a user-visible failure here
        // (they asked for a bio and got none), so surface it, don't stay silent.
        if (!r.bio && r.urls.length === 0) {
          this.toasts.show({ kind: 'error', message: 'No bio found for this artist.' });
        }
      },
      error: () => {
        this.refreshing.set(false);
        this.toasts.show({ kind: 'error', message: 'Could not fetch artist info.' });
      },
    });
  }

  /** Silent auto-fetch (issue #213 part 1). Same backend as `refresh()` but
   *  always available (not curator-gated), never surfaces a toast on any
   *  outcome, and is naturally a one-shot per artist (the server tombstones
   *  on a confident miss so subsequent visits see `metaExists=true`). */
  private autoFetch(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.api.autoFetchArtistInfo(this.artistId()).subscribe({
      next: (r) => {
        this.refreshing.set(false);
        this.shownBio.set(r.bio);
        this.shownUrls.set(r.urls);
        this.updated.emit(r);
        // Silent — the inline bio is the confirmation, the miss is silent.
      },
      error: () => {
        this.refreshing.set(false);
        // Silent — auto-fetch must never toast.
      },
    });
  }

  toggleExpanded(): void {
    this.expanded.set(!this.expanded());
  }

  toggleSources(): void {
    this.sourcesOpen.set(!this.sourcesOpen());
  }

  /**
   * Measure the bio element's content height vs. its clamped height. The
   * toggle should only appear when content is *actually* clipped — comparing
   * raw char counts doesn't account for the visual clip (a 280-char bio may
   * be wider than 4 lines, a 300-char bio may fit in 4; the toggle should
   * match the visual state, not a char count). Pure logic lives in
   * {@link isOverflowing} so it's unit-testable.
   */
  private measureOverflow(): void {
    const el = this.bioEl()?.nativeElement;
    if (!el) {
      this.hasOverflow.set(false);
      return;
    }
    this.hasOverflow.set(isOverflowing(el));
  }
}
