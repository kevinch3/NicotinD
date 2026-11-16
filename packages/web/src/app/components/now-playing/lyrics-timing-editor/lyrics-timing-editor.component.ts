import {
  Component,
  ElementRef,
  computed,
  effect,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { haptic } from '../../../lib/haptics';
import {
  activeTimingRow,
  canSaveTiming,
  clearRow,
  formatTimingStamp,
  fromHereToEnd,
  nextUnstamped,
  retextRow,
  shiftRows,
  stampRow,
  stampedCount,
  timingPayload,
  type TimingRow,
} from '../../../lib/lyrics-timing-draft';

/** A long press on a row starts a selection after this long. */
const HOLD_MS = 500;
/** "Play from here" starts this far before the line. */
const LEAD_IN_MS = 2000;

interface StampUndo {
  index: number;
  before: number | null;
  target: number;
}

/**
 * The lyrics timing editor (#1675, docs/lyrics-options.md §4): stamp each line
 * at the playhead while the song plays, retime one line or a range with
 * steppers, and save words and timings together.
 *
 * It owns the draft and nothing else. Playback stays the player's: the editor
 * reads the clock through `clock` at the moment of a press, and asks for seeks
 * and play/pause through its outputs.
 */
@Component({
  selector: 'app-lyrics-timing-editor',
  imports: [TranslatePipe],
  host: { '(keydown.escape)': 'cancelled.emit()' },
  templateUrl: './lyrics-timing-editor.component.html',
})
export class LyricsTimingEditorComponent {
  /** The rows to start from; the draft is a private copy. */
  readonly initial = input<readonly TimingRow[]>([]);
  /** The playhead in ms, for the readout and the preview highlight. */
  readonly positionMs = input(0);
  readonly durationMs = input(0);
  readonly playing = input(false);
  readonly saving = input(false);
  /**
   * The audio element's own clock in ms, read at the press that stamps. The
   * `positionMs` signal lags it by up to one `timeupdate` (about 250 ms).
   */
  readonly clock = input<() => number>(() => 0);

  readonly cancelled = output<void>();
  readonly saved = output<{ plain: string; synced: string }>();
  /** A seek request, in ms. */
  readonly seek = output<number>();
  readonly playToggled = output<void>();

  readonly rows = linkedSignal<TimingRow[]>(() => this.initial().map((r) => ({ ...r })));
  /** The line the next stamp goes to; -1 once every line has one. */
  readonly target = linkedSignal(() => nextUnstamped(this.initial()));
  /** The row whose stepper is open. */
  readonly openRow = signal<number | null>(null);
  /** The row whose words are being edited. */
  readonly editingRow = signal<number | null>(null);
  readonly selection = signal<ReadonlySet<number>>(new Set());
  /** Preview: the list follows playback the way karaoke will. */
  readonly preview = signal(false);
  private readonly undoStack = signal<StampUndo[]>([]);

  readonly stamped = computed(() => stampedCount(this.rows()));
  readonly canSave = computed(() => canSaveTiming(this.rows()) && !this.saving());
  readonly canUndo = computed(() => this.undoStack().length > 0);
  readonly activeRow = computed(() =>
    this.preview() ? activeTimingRow(this.rows(), this.positionMs()) : -1,
  );

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Keep the line being worked on in view: the target, or the active preview line.
    effect(() => {
      const index = this.preview() ? this.activeRow() : this.target();
      const host = this.list()?.nativeElement;
      if (!host || index < 0) return;
      const row = host.querySelector<HTMLElement>(`[data-row="${index}"]`);
      row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
  }

  readonly stamp = formatTimingStamp;

  /** STAMP: the target line takes the clock's time, and the target moves on. */
  stampTarget(): void {
    const index = this.target();
    if (index < 0) return;
    const before = this.rows()[index]!.timeMs;
    this.rows.set(stampRow(this.rows(), index, this.clock()()));
    this.undoStack.update((s) => [...s, { index, before, target: index }]);
    this.target.set(nextUnstamped(this.rows(), index + 1));
    haptic('tap');
  }

  /** Undo the last stamp and put the target back on its line. */
  undo(): void {
    const last = this.undoStack().at(-1);
    if (!last) return;
    this.undoStack.update((s) => s.slice(0, -1));
    this.rows.set(
      last.before === null
        ? clearRow(this.rows(), last.index)
        : stampRow(this.rows(), last.index, last.before),
    );
    this.target.set(last.target);
  }

  /** Tap a line's words: it becomes the target, or extends a selection in progress. */
  pickRow(index: number): void {
    if (this.selection().size > 0) {
      const from = Math.min(...this.selection(), index);
      const to = Math.max(...this.selection(), index);
      this.selection.set(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)));
      return;
    }
    this.target.set(index);
  }

  toggleStepper(index: number): void {
    this.openRow.set(this.openRow() === index ? null : index);
  }

  /** A stepper press: moves the whole selection when this row is in it, else this row. */
  nudge(index: number, deltaMs: number): void {
    const chosen = this.selection().has(index) ? this.selection() : [index];
    this.rows.set(shiftRows(this.rows(), chosen, deltaMs));
  }

  setToNow(index: number): void {
    this.rows.set(stampRow(this.rows(), index, this.clock()()));
  }

  playFromHere(index: number): void {
    const at = this.rows()[index]?.timeMs;
    if (at === null || at === undefined) return;
    this.seek.emit(Math.max(0, at - LEAD_IN_MS));
    if (!this.playing()) this.playToggled.emit();
  }

  selectFromHere(index: number): void {
    this.selection.set(new Set(fromHereToEnd(this.rows(), index)));
  }

  clearSelection(): void {
    this.selection.set(new Set());
  }

  startHold(index: number): void {
    this.cancelHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.selection.set(new Set([index]));
      haptic('hold');
    }, HOLD_MS);
  }

  cancelHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  startEdit(index: number): void {
    this.editingRow.set(index);
  }

  commitEdit(index: number, text: string): void {
    this.rows.set(retextRow(this.rows(), index, text.trim()));
    this.editingRow.set(null);
  }

  skip(deltaMs: number): void {
    this.seek.emit(Math.max(0, this.clock()() + deltaMs));
  }

  /** Preview plays from the line being worked on. */
  togglePreview(): void {
    const on = !this.preview();
    this.preview.set(on);
    if (!on) return;
    const from = this.rows()[this.openRow() ?? Math.max(0, this.target())]?.timeMs;
    if (from !== null && from !== undefined) this.seek.emit(Math.max(0, from - LEAD_IN_MS));
    if (!this.playing()) this.playToggled.emit();
  }

  save(): void {
    if (!this.canSave()) return;
    this.saved.emit(timingPayload(this.rows()));
  }
}
