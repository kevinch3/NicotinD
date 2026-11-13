import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

interface DemoCredit {
  artist: string;
  title: string;
  licence: string;
  sourceUrl: string;
}

/**
 * The static demo's one piece of chrome (docs/demo-mode.md): a strip saying
 * nothing is saved, a link to the project, and the credits the CC licences of
 * the demo library require. Rendered only in the `demo` build.
 */
@Component({
  selector: 'app-demo-banner',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="demo-banner"
      class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs bg-theme-accent text-theme-on-accent"
    >
      <span>{{ 'demo.banner' | t }}</span>
      <a
        class="underline font-medium"
        href="https://github.com/kevinch3/NicotinD"
        target="_blank"
        rel="noopener"
        >{{ 'demo.getIt' | t }}</a
      >
      <button type="button" class="underline" data-testid="demo-credits-toggle" (click)="toggle()">
        {{ 'demo.credits' | t }}
      </button>
    </div>
    @if (open()) {
      <div
        data-testid="demo-credits"
        class="px-4 py-3 text-xs bg-theme-surface border-b border-theme"
      >
        <p class="mb-2">{{ 'demo.creditsIntro' | t }}</p>
        <ul class="space-y-1">
          @for (c of credits(); track c.sourceUrl) {
            <li>
              <a class="underline" [href]="c.sourceUrl" target="_blank" rel="noopener"
                >{{ c.artist }} — {{ c.title }}</a
              >
              ·
              <a class="underline" [href]="c.licence" target="_blank" rel="noopener">{{
                licenceName(c.licence)
              }}</a>
            </li>
          }
        </ul>
      </div>
    }
  `,
})
export class DemoBannerComponent {
  readonly open = signal(false);
  readonly credits = signal<DemoCredit[]>([]);

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open() && this.credits().length === 0) {
      void fetch('demo-data/credits.json')
        .then((r) => (r.ok ? (r.json() as Promise<DemoCredit[]>) : []))
        .then((c) => this.credits.set(c))
        .catch(() => {});
    }
  }

  /** `…/licenses/by-sa/3.0/` → "CC BY-SA 3.0"; CC0 by name. */
  licenceName(url: string): string {
    if (/publicdomain\/zero/.test(url)) return 'CC0 1.0';
    const m = /licenses\/([a-z-]+)\/([\d.]+)/.exec(url);
    return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : url;
  }
}
