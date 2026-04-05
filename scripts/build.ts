import { spawnSync } from 'node:child_process';

const rootDir = import.meta.dir + '/..';

function step(label: string, cmd: string, args: string[], cwd = rootDir): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (result.status !== 0) {
    console.error(`✗ ${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label}`);
}

console.log('Building NicotinD…\n');

// 1. Type-check all packages
step('TypeScript type check', 'bun', ['run', 'typecheck']);

// 2. Build the web UI (Vite)
step('Web UI (Angular build)', 'bun', ['run', 'build'], rootDir + '/packages/web');

console.log('\n✅ Build complete.');
