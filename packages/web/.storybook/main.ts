import { freemem } from 'node:os';
import type { StorybookConfig } from '@storybook/angular';

const config: StorybookConfig = {
  // `src/stories/**` holds the hand-written Foundations/Patterns pages. Those were
  // MDX-only until a Foundations page needed a *rendered* example (the i18n
  // language global, issue #476) rather than prose, so code stories are picked up
  // there too.
  stories: [
    '../src/stories/**/*.mdx',
    '../src/stories/**/*.stories.ts',
    '../src/app/**/*.stories.ts',
  ],
  addons: ['@storybook/addon-docs', '@storybook/addon-themes', '@storybook/addon-a11y'],
  framework: { name: '@storybook/angular', options: {} },
  staticDirs: ['../public'],
  docs: { defaultName: 'Docs' },
  webpackFinal: (webpackConfig) => {
    // `@nicotind/core` is TypeScript source using ESM-style `./licence.js` specifiers.
    // The app's esbuild builder resolves those natively; webpack does not, and reports
    // "Can't resolve './licence.js'". This maps a `.js` specifier back onto its `.ts`
    // source, which is the only reason Storybook can reach the shared core types.
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.js'],
    };
    // Minifying is the build's memory peak: Terser's parallel pass took the whole
    // build to 3.5 GB and has been OOM-killed (exit 137) on a busy dev machine,
    // leaving a stale storybook-static for the gates to grade. The gates check
    // behaviour, not bundle bytes, so a short-memory machine skips it (#1906).
    if (lowMemory()) {
      webpackConfig.optimization ??= {};
      webpackConfig.optimization.minimize = false;
    }
    return webpackConfig;
  },
};

/** `NICOTIND_LOW_MEM=1`, or under 4 GB free: CI runners have the headroom, a busy laptop does not. */
function lowMemory(): boolean {
  if (process.env['NICOTIND_LOW_MEM'] === '0') return false;
  const free = process.availableMemory?.() ?? freemem();
  return process.env['NICOTIND_LOW_MEM'] === '1' || free < 4 * 1024 ** 3;
}

export default config;
