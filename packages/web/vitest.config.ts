import { defineConfig, type Plugin } from 'vitest/config';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vitest plugin that inlines Angular component templateUrl/styleUrls at transform time,
 * replacing them with the actual file contents. This lets JIT compilation work without
 * an HTTP server or the Angular CLI's Vite plugin.
 */
function angularTemplateInliner(): Plugin {
  return {
    name: 'angular-template-inliner',
    transform(code, id) {
      if (!id.endsWith('.ts') || id.includes('node_modules')) return;
      if (
        !code.includes('templateUrl') &&
        !code.includes('styleUrls') &&
        !code.includes('styleUrl')
      )
        return;

      const dir = dirname(id);
      let transformed = code;

      // Replace: templateUrl: './foo.component.html'  →  template: `<file contents>`
      transformed = transformed.replace(
        /templateUrl:\s*['"]([^'"]+)['"]/g,
        (_match, url: string) => {
          try {
            const content = readFileSync(resolve(dir, url), 'utf-8');
            const escaped = content
              .replace(/\\/g, '\\\\')
              .replace(/`/g, '\\`')
              .replace(/\$\{/g, '\\${');
            return `template: \`${escaped}\``;
          } catch {
            return _match;
          }
        },
      );

      // Replace: styleUrls: ['./foo.component.css']  →  styles: [`<css>`]
      transformed = transformed.replace(/styleUrls:\s*\[([^\]]*)\]/g, (_match, urlList: string) => {
        const urls = [...urlList.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
        const styles = urls.map((url) => {
          try {
            const content = readFileSync(resolve(dir, url), 'utf-8');
            return '`' + content.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
          } catch {
            return '``';
          }
        });
        return `styles: [${styles.join(', ')}]`;
      });

      // Replace: styleUrl: './foo.component.css'  →  styles: [`<css>`]
      transformed = transformed.replace(/styleUrl:\s*['"]([^'"]+)['"]/g, (_match, url: string) => {
        try {
          const content = readFileSync(resolve(dir, url), 'utf-8');
          return 'styles: [`' + content.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`]';
        } catch {
          return _match;
        }
      });

      return transformed;
    },
  };
}

export default defineConfig({
  plugins: [angularTemplateInliner()],
  resolve: {
    alias: {
      '@nicotind/core': resolve(__dirname, 'src/types/core.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    setupFiles: ['./src/test-setup.ts'],
    // `forks` (the default) pays a child_process spawn per worker; nothing here needs
    // process isolation (no `process.chdir`, no native module state), so threads are
    // strictly cheaper.
    pool: 'threads',
    // The default leaves one core idle. This suite is CPU-bound, not memory-bound —
    // measured at 193 files / 2056 tests, the cost is jsdom construction and Angular
    // JIT, both of which scale with workers.
    maxWorkers: '100%',
    // `isolate: false` was measured at **14.1s vs 134.7s** — a 9x win — and is
    // deliberately NOT taken. It re-uses one module registry per worker, and three
    // specs in desktop-window-controls depend on `vi.mock` of `lib/platform` resolving
    // per-file; with the registry shared they see another file's module and fail. Two
    // *real* bugs it surfaced are fixed (platform.spec.ts and native-capabilities.spec.ts
    // `delete`d the global `window` instead of restoring it), so the remaining gap is
    // only the mock-registry one. Re-evaluate behind `bun run check:isolated-specs --web`;
    // a green-then-flaky suite costs more than the 2 minutes this saves, and `web-test`
    // is no longer on the workflow's critical path.
    isolate: true,
  },
});
