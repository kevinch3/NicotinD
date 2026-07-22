import { Component, computed, input, output } from '@angular/core';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';
import {
  CAMELOT_WHEEL,
  MOOD_VOCAB,
  LICENCE_VOCAB,
  LICENCE_LABELS,
  PERCEPTUAL_AXES,
  activeLibraryFilterCount,
  type LibraryFilter,
  type LicenceCode,
  type MoodLabel,
  type PerceptualAxis,
  type PerceptualBucket,
} from '@nicotind/core';

type NumericField = 'bpmMin' | 'bpmMax' | 'yearMin' | 'yearMax';
type DurationField = 'durationMin' | 'durationMax';

/**
 * The standardized library filter disclosure: trigger button + viewport-safe
 * MenuPanel popover + active-count badge, editing one shared `LibraryFilter`.
 * Stateless — the host owns the filter (usually mirrored into URL query
 * params) and every control emits a fresh immutable object via `filterChange`.
 * Page-specific extras (e.g. Albums' min-tracks / show-hidden) project into
 * the panel through the content slot and report their count via `extraCount`.
 */
@Component({
  selector: 'app-library-filter-panel',
  imports: [MenuPanelComponent],
  templateUrl: './library-filter-panel.component.html',
})
export class LibraryFilterPanelComponent {
  readonly filter = input<LibraryFilter>({});
  /** Genre options for the multi-select (host lazy-loads via panelOpened). */
  readonly genres = input<string[]>([]);
  /** data-testid prefix so multiple panels stay distinguishable in e2e. */
  readonly testIdPrefix = input('library');
  /** Count of active page-specific filters projected via the content slot. */
  readonly extraCount = input(0);

  readonly filterChange = output<LibraryFilter>();
  /** Fires on trigger clicks — hosts lazy-load genre options on first open. */
  readonly panelOpened = output<void>();

  readonly badgeCount = computed(
    () => activeLibraryFilterCount(this.filter()) + this.extraCount(),
  );

  // Template vocab
  readonly camelotWheel = CAMELOT_WHEEL;
  readonly moodOptions = MOOD_VOCAB;
  readonly licenceOptions = LICENCE_VOCAB;
  readonly bucketOptions: readonly PerceptualBucket[] = ['low', 'mid', 'high'];
  readonly axisOptions: ReadonlyArray<{ axis: PerceptualAxis; label: string }> = [
    { axis: 'energy', label: 'Energy' },
    { axis: 'danceability', label: 'Danceable' },
    { axis: 'valence', label: 'Positivity' },
    { axis: 'acousticness', label: 'Acoustic' },
    { axis: 'instrumental', label: 'Instrumental' },
  ];

  private emitFilter(next: LibraryFilter): void {
    this.filterChange.emit(next);
  }

  private without(f: LibraryFilter, key: keyof LibraryFilter): LibraryFilter {
    const rest = { ...f };
    delete rest[key];
    return rest;
  }

  toggleStarred(): void {
    const f = this.filter();
    this.emitFilter(f.starred ? this.without(f, 'starred') : { ...f, starred: true });
  }

  toggleMood(mood: MoodLabel): void {
    const f = this.filter();
    const current = f.moods ?? [];
    const next = current.includes(mood)
      ? current.filter((m) => m !== mood)
      : [...current, mood];
    this.emitFilter(next.length ? { ...f, moods: next } : this.without(f, 'moods'));
  }

  isMoodActive(mood: MoodLabel): boolean {
    return this.filter().moods?.includes(mood) ?? false;
  }

  toggleKey(code: string): void {
    const f = this.filter();
    const current = f.keys ?? [];
    const next = current.includes(code)
      ? current.filter((k) => k !== code)
      : [...current, code];
    this.emitFilter(next.length ? { ...f, keys: next } : this.without(f, 'keys'));
  }

  isKeyActive(code: string): boolean {
    return this.filter().keys?.includes(code) ?? false;
  }

  toggleGenre(genre: string): void {
    const f = this.filter();
    const current = f.genres ?? [];
    const next = current.includes(genre)
      ? current.filter((g) => g !== genre)
      : [...current, genre];
    this.emitFilter(next.length ? { ...f, genres: next } : this.without(f, 'genres'));
  }

  isGenreActive(genre: string): boolean {
    return this.filter().genres?.includes(genre) ?? false;
  }

  licenceLabel(code: string): string {
    return LICENCE_LABELS[code as LicenceCode] ?? code;
  }

  toggleLicence(code: string): void {
    const f = this.filter();
    const current = f.licences ?? [];
    const next = current.includes(code)
      ? current.filter((l) => l !== code)
      : [...current, code];
    this.emitFilter(next.length ? { ...f, licences: next } : this.without(f, 'licences'));
  }

  isLicenceActive(code: string): boolean {
    return this.filter().licences?.includes(code) ?? false;
  }

  toggleBucket(axis: PerceptualAxis, bucket: PerceptualBucket): void {
    const f = this.filter();
    const buckets = { ...(f.buckets ?? {}) };
    const current = buckets[axis] ?? [];
    const next = current.includes(bucket)
      ? current.filter((b) => b !== bucket)
      : [...current, bucket];
    if (next.length) buckets[axis] = next;
    else delete buckets[axis];
    this.emitFilter(
      Object.keys(buckets).length ? { ...f, buckets } : this.without(f, 'buckets'),
    );
  }

  isBucketActive(axis: PerceptualAxis, bucket: PerceptualBucket): boolean {
    return this.filter().buckets?.[axis]?.includes(bucket) ?? false;
  }

  /** `<input type="number">` value → filter field; empty/garbage clears it. */
  setNumber(field: NumericField, raw: string): void {
    const f = this.filter();
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
      this.emitFilter(this.without(f, field));
    } else {
      this.emitFilter({ ...f, [field]: n });
    }
  }

  numberValue(field: NumericField): string {
    const v = this.filter()[field];
    return v === undefined ? '' : String(v);
  }

  /** Duration is stored in seconds but edited in minutes (fractions allowed). */
  setDurationMinutes(field: DurationField, raw: string): void {
    const f = this.filter();
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
      this.emitFilter(this.without(f, field));
    } else {
      this.emitFilter({ ...f, [field]: Math.round(n * 60) });
    }
  }

  durationMinutes(field: DurationField): string {
    const seconds = this.filter()[field];
    if (seconds === undefined) return '';
    return String(Math.round((seconds / 60) * 10) / 10);
  }

  clearAll(): void {
    this.emitFilter({});
  }
}
