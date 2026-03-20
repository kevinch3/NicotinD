import { spawn } from 'node:child_process';

const procs: ReturnType<typeof spawn>[] = [];
const rootDir = import.meta.dir + '/..';

// Use external mode if --external flag is passed, otherwise embedded
const useExternal = process.argv.includes('--external');
const mode = useExternal ? 'external' : 'embedded';

function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  const proc = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    cwd: rootDir,
  });
  proc.on('error', (err) => console.error(`[${name}] error:`, err.message));
  proc.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  procs.push(proc);
}

console.log(`Starting NicotinD in ${mode} mode...\n`);

// Backend — embedded mode auto-downloads binaries on first run
run('api', 'bun', ['run', 'src/main.ts'], { NICOTIND_MODE: mode });

// Vite dev server for the web UI
run('web', 'bun', ['run', '--cwd', 'packages/web', 'dev']);

function shutdown() {
  for (const proc of procs) proc.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
