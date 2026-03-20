import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@nicotind/core';
import type { IServiceStrategy, ServiceDefinition, ServiceHandle } from './strategy.js';

const log = createLogger('process-strategy');

const processes = new Map<string, { proc: ChildProcess; logs: string[] }>();

const MAX_LOG_LINES = 1000;

export class NativeProcessStrategy implements IServiceStrategy {
  async start(service: ServiceDefinition): Promise<ServiceHandle> {
    log.info({ name: service.name, command: service.command }, 'Starting service');

    const proc = spawn(service.command, service.args, {
      env: { ...process.env, ...service.env },
      cwd: service.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logs: string[] = [];
    const appendLog = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      logs.push(...lines);
      if (logs.length > MAX_LOG_LINES) {
        logs.splice(0, logs.length - MAX_LOG_LINES);
      }
    };

    proc.stdout?.on('data', appendLog);
    proc.stderr?.on('data', appendLog);

    proc.on('exit', (code) => {
      log.info({ name: service.name, code }, 'Service exited');
      processes.delete(service.name);
    });

    processes.set(service.name, { proc, logs });

    return { name: service.name, pid: proc.pid };
  }

  async stop(handle: ServiceHandle): Promise<void> {
    const entry = processes.get(handle.name);
    if (!entry) return;

    log.info({ name: handle.name }, 'Stopping service');
    entry.proc.kill('SIGTERM');

    // Wait up to 10s for graceful shutdown, then force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        entry.proc.kill('SIGKILL');
        resolve();
      }, 10_000);

      entry.proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    processes.delete(handle.name);
  }

  async restart(handle: ServiceHandle, service: ServiceDefinition): Promise<ServiceHandle> {
    await this.stop(handle);
    return this.start(service);
  }

  async isRunning(handle: ServiceHandle): Promise<boolean> {
    const entry = processes.get(handle.name);
    if (!entry) return false;

    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(entry.proc.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }

  async getLogs(handle: ServiceHandle, lines = 100): Promise<string[]> {
    const entry = processes.get(handle.name);
    if (!entry) return [];
    return entry.logs.slice(-lines);
  }
}
