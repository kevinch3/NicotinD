import type { Decorator, Preview } from '@storybook/angular';
import { withThemeByDataAttribute } from '@storybook/addon-themes';

// Tailwind and the theme tokens arrive via the `browserTarget` in angular.json — the
// angular-cli preset reads that target's `styles: ["src/styles.css"]` and its PostCSS
// handling. Do not import the stylesheet here; TypeScript cannot type a `.css` module.

/** Mirrors `ThemeId` in src/app/services/theme.service.ts. */
const THEMES = {
  Midnight: 'midnight',
  Daylight: 'daylight',
  'Warm Paper': 'warm-paper',
  'OLED Black': 'oled',
  Twilight: 'twilight',
  Forest: 'forest',
  'E-Ink': 'eink',
} as const;

/**
 * Paint the story canvas with the active theme.
 *
 * Storybook's canvas is white and the app's background lives on the layout shell
 * (`bg-theme-base`), which no story renders. Without this a dark theme puts light text
 * on white — axe reported ~70 contrast failures that were purely this artifact, against
 * a background the app never shows.
 */
const withThemedCanvas: Decorator = (story) => {
  document.body.style.backgroundColor = 'var(--theme-bg)';
  document.body.style.color = 'var(--theme-text-primary)';
  return story();
};

/**
 * Toggle `html.tv-build`, the 10-foot surface. This axis has no other review surface —
 * the overscan insets and D-pad focus rings are otherwise only observable on an Android
 * TV emulator (`bun run e2e:tv`).
 */
const withTvBuild: Decorator = (story, context) => {
  document.documentElement.classList.toggle('tv-build', context.globals['tvBuild'] === 'on');
  return story();
};

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute({
      themes: THEMES,
      defaultTheme: 'Midnight',
      attributeName: 'data-theme',
    }),
    withTvBuild,
    withThemedCanvas,
  ],
  globalTypes: {
    tvBuild: {
      description: 'Render inside the Android TV build (html.tv-build)',
      toolbar: {
        title: 'TV build',
        icon: 'browser',
        items: [
          { value: 'off', title: 'Off' },
          { value: 'on', title: 'On' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { tvBuild: 'off' },
  parameters: {
    // The app is zoneless (Angular 22 default, no zone.js dependency). Without this,
    // stories bootstrap with zone-based change detection and drift from the real app.
    angular: { experimentalZoneless: true },
    controls: { expanded: true },
    viewport: {
      options: {
        mobile: { name: 'Mobile', styles: { width: '390px', height: '844px' } },
        tablet: { name: 'Tablet', styles: { width: '820px', height: '1180px' } },
        desktop: { name: 'Desktop', styles: { width: '1440px', height: '900px' } },
      },
    },
    options: {
      storySort: { order: ['Foundations', 'Components', 'Patterns'] },
    },
  },
};

export default preview;
