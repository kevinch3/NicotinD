import { spawn } from 'node:child_process';

const procs: ReturnType<typeof spawn>[] = [];

function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  const proc = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    cwd: import.meta.dir + '/..',
  });
  proc.on('error', (err) => console.error(`[${name}] error:`, err.message));
  proc.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  procs.push(proc);
}

// Backend (external mode so it doesn't need slskd/navidrome binaries)
run('api', 'bun', ['run', 'src/main.ts'], { NICOTIND_MODE: 'external' });

// Vite dev server for the web UI
run('web', 'bun', ['run', '--cwd', 'packages/web', 'dev']);

function shutdown() {
  for (const proc of procs) proc.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
