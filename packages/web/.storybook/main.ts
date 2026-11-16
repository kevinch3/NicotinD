import type { StorybookConfig } from '@storybook/angular-vite';

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
  framework: { name: '@storybook/angular-vite', options: {} },
  staticDirs: ['../public'],
  docs: { defaultName: 'Docs' },
  viteFinal: async (viteConfig) => {
    // The app's builder reads `postcss.config.json`, a name Vite does not look
    // for. Without this the stylesheet ships with no Tailwind utilities at all:
    // every story still mounts, with `hidden` and the rest doing nothing (#478).
    const { default: tailwindcss } = await import('@tailwindcss/postcss');
    // Cast: the plugin and Vite each resolve their own copy of postcss's types.
    const postcss = { plugins: [tailwindcss()] } as unknown as NonNullable<
      typeof viteConfig.css
    >['postcss'];
    viteConfig.css = { ...viteConfig.css, postcss };
    return viteConfig;
  },
};

export default config;
