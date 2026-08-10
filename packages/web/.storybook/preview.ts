import type { Preview } from '@storybook/angular';

// Tailwind and the theme tokens arrive via the `browserTarget` in angular.json — the
// angular-cli preset reads that target's `styles: ["src/styles.css"]` and its PostCSS
// handling. Do not import the stylesheet here; TypeScript cannot type a `.css` module.

const preview: Preview = {
  parameters: {
    // The app is zoneless (Angular 22 default, no zone.js dependency). Without this,
    // stories bootstrap with zone-based change detection and drift from the real app.
    angular: { experimentalZoneless: true },
    controls: { expanded: true },
    options: {
      storySort: { order: ['Foundations', 'Components', 'Patterns'] },
    },
  },
};

export default preview;
