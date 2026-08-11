import type { StorybookConfig } from '@storybook/angular';

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.mdx', '../src/app/**/*.stories.ts'],
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
    return webpackConfig;
  },
};

export default config;
