import type { Meta, StoryObj } from '@storybook/angular';
import { Component } from '@angular/core';
import { moduleMetadata, applicationConfig } from '@storybook/angular';
import { TranslatePipe } from '../../app/pipes/translate.pipe';
import { storyProviders } from '../support/story-providers';

/**
 * The keys with the largest English -> Spanish growth in the shipped catalogs,
 * rendered in a deliberately narrow column.
 *
 * Chosen by measuring the real bundles rather than by eye: these are the top
 * absolute-growth strings in `public/i18n/es.json`, the ones most likely to
 * overflow a container that was only ever laid out against English.
 */
const LONGEST = [
  'admin.computeThrottleHint',
  'extensions.acquisitionOffAfter',
  'admin.gatedStepsHint',
  'agentTokens.subtitle',
  'settings.generationFeedbackHint',
  'admin.musicImportRemoveOriginalsHint',
  'settings.autoPreserveExplainOff',
  'admin.backupHint',
];

@Component({
  selector: 'app-i18n-longest',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div class="space-y-4">
      @for (key of keys; track key) {
        <div>
          <p class="text-[10px] font-mono text-theme-muted mb-1">{{ key }}</p>
          <!-- 320px is the narrowest real container in the app (the mobile
               settings column), so anything that wraps badly here wraps badly
               on a phone. -->
          <div
            class="w-[320px] p-3 rounded-lg border border-theme bg-theme-surface text-sm text-theme-primary"
          >
            {{ key | t }}
          </div>
        </div>
      }
    </div>
  `,
})
class I18nLongestComponent {
  readonly keys = LONGEST;
}

/**
 * Switch the **Language** toolbar global to see the same strings in Spanish.
 *
 * Verified rather than assumed: flipping the global re-renders these stories,
 * because the `t` pipe is `pure: false`. A pure pipe memoizes on its arguments,
 * so it would never re-run on a language change and the panel would silently
 * keep showing English. (Storybook also re-creates the story's Angular
 * application on a globals change, which is what re-applies the language in
 * `storyProviders()`.)
 *
 * The catalogs are the real `public/i18n/*.json`, served through Storybook's
 * `staticDirs` — not a stub, so what you read here is the copy that ships.
 */
const meta: Meta<I18nLongestComponent> = {
  title: 'Foundations/Internationalization',
  component: I18nLongestComponent,
  decorators: [
    applicationConfig({ providers: storyProviders() }),
    moduleMetadata({ imports: [TranslatePipe] }),
  ],
};
export default meta;

type Story = StoryObj<I18nLongestComponent>;

/** The eight highest-growth strings, in a 320px column. */
export const LongestStrings: Story = {};

/**
 * The `t` pipe itself (issue #477): key in, copy out, falling through
 * active -> base -> **the key itself**.
 *
 * That last step is the one worth seeing. A missing key renders as the raw key
 * rather than blank, so a gap in a translation is visible in the UI instead of
 * silently erasing a label — which is why `es.json` being at full parity is a
 * checkable claim rather than a hope. The last row below is a key that exists in
 * no catalog; switch the **Language** global and the real rows change while it
 * stays put.
 */
export const TranslatePipeFallback: Story = {
  render: () => ({
    template: `
      <div class="space-y-2 w-[420px]">
        @for (key of keys; track key) {
          <div class="flex items-center gap-3 text-sm">
            <code class="text-[10px] text-theme-muted w-[190px] shrink-0">{{ key }}</code>
            <span class="text-theme-primary">{{ key | t }}</span>
          </div>
        }
      </div>
    `,
    props: {
      keys: [
        'home.recentlyPlayed',
        'common.back',
        'common.next',
        'library.find.placeholder',
        'this.key.does.not.exist',
      ],
    },
  }),
};
