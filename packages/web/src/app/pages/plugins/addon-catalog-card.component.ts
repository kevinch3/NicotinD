import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  effect,
  OnDestroy,
} from '@angular/core';
// why: this card is nested inside plugins.component, and the JIT vitest harness
// throws NG0950 on a required input of a nested component (see
// src/testing/signal-input.ts). An optional input + a template guard is the
// robust contract; callers always bind an entry in practice.
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import {
  AddonCatalogService,
  type AddonCatalogItem,
  type AddonInstallResult,
} from '../../services/addon-catalog.service';

/**
 * One card in the Extensions "Available add-ons" marketplace (issue #517).
 *
 * Flow: **Install** mints a token server-side + writes a pending registration
 * and returns the compose snippet with that token baked in (no copy-paste of a
 * token). The admin pastes the snippet + brings the container up; the card polls
 * until the server auto-detects it (promotes pending → installed), then offers
 * **Enable** (which runs the parent page's consent flow via `enableRequested`).
 */
@Component({
  selector: 'app-addon-catalog-card',
  standalone: true,
  imports: [TranslatePipe, TvNavItemDirective],
  templateUrl: './addon-catalog-card.component.html',
})
export class AddonCatalogCardComponent implements OnDestroy {
  private readonly catalog = inject(AddonCatalogService);
  readonly entry = input<AddonCatalogItem>();
  /** The parent page owns the consent dialog + PluginService, so enabling is
   *  delegated up with the addon id. */
  readonly enableRequested = output<string>();

  readonly busy = signal(false);
  readonly copied = signal(false);
  /** The install response (minted token + snippet), kept while pending. */
  readonly install = signal<AddonInstallResult | null>(null);

  /** The snippet to display — the real minted-token one once installed. */
  readonly snippet = computed(() => this.install()?.composeSnippet ?? null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Stop polling the moment the server reports the container detected.
    effect(() => {
      if (this.entry()?.state === 'installed') this.stopPoll();
    });
  }

  ngOnDestroy(): void {
    this.stopPoll();
  }

  /** Mint the token + pending registration, reveal the snippet, start polling. */
  async doInstall(): Promise<void> {
    const e = this.entry();
    if (!e || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await this.catalog.install(e.id);
      this.install.set(result);
      await this.catalog.refresh(); // flip the card to 'pending'
      this.startPoll();
    } finally {
      this.busy.set(false);
    }
  }

  /** "Check now" — ask the server to re-detect immediately. */
  async checkNow(): Promise<void> {
    const e = this.entry();
    if (!e || this.busy()) return;
    this.busy.set(true);
    try {
      await this.catalog.check(e.id);
      await this.catalog.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  requestEnable(): void {
    const e = this.entry();
    if (e) this.enableRequested.emit(e.id);
  }

  async copySnippet(): Promise<void> {
    const full = this.snippet()?.full;
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the text stays
      // selectable in the <pre>, so this is a non-fatal nicety.
    }
  }

  private startPoll(): void {
    this.stopPoll();
    // A short cadence while the admin brings the container up. GET /catalog
    // promotes server-side, so a plain refresh detects activation.
    this.pollTimer = setInterval(() => void this.catalog.refresh(), 5000);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
