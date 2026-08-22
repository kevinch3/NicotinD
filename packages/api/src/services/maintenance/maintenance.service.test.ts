/**
 * Tests for the maintenance runner: the busy guard, cancellation, progress
 * accumulation and the deliberately non-persistent status (issue #622).
 */
import { describe, expect, it } from 'bun:test';
import { MaintenanceService } from './maintenance.service.js';
import type { AnyMaintenanceTask, MaintenanceRunContext } from './tasks.js';

/** A task whose body the test drives. */
function fakeTask(
  run: (ctx: MaintenanceRunContext) => Promise<void>,
  over: Partial<AnyMaintenanceTask> = {},
): AnyMaintenanceTask {
  return {
    id: 'metadata-optimize',
    label: 'Fake',
    available: () => true,
    parseParams: () => ({}),
    describe: () => ({ summary: 'fake', dryRun: false }),
    run: async (ctx) => {
      await run(ctx);
      return { detail: { checked: 1 }, stopped: false, errorSample: null };
    },
    ...over,
  } as AnyMaintenanceTask;
}

const noDeps = {
  db: null as never,
  lidarr: null,
  musicDir: '/music',
  runSync: null,
};

function svcWith(task: AnyMaintenanceTask): MaintenanceService {
  return new MaintenanceService(noDeps, { tasks: [task] });
}

const q = new URLSearchParams();

/** Resolve after the microtask queue drains, letting the run body advance. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('MaintenanceService', () => {
  it('starts idle and reports no history (the restart contract)', () => {
    const s = svcWith(fakeTask(async () => {})).getStatus();
    expect(s.phase).toBe('idle');
    expect(s.taskId).toBeNull();
    expect(s.lastOutcome).toBeNull();
    expect(s.visited).toBe(0);
  });

  it('refuses an unknown task', () => {
    expect(svcWith(fakeTask(async () => {})).start('nope', q)).toBe('unknown-task');
  });

  it('refuses a task that reports itself unavailable', () => {
    const svc = svcWith(fakeTask(async () => {}, { available: () => 'Lidarr is not configured' }));
    expect(svc.start('metadata-optimize', q)).toBe('unavailable');
    expect(svc.getStatus().phase).toBe('idle');
  });

  it('refuses a second start while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = svcWith(fakeTask(() => gate));

    expect(svc.start('metadata-optimize', q)).toBe('started');
    expect(svc.start('metadata-optimize', q)).toBe('busy');
    expect(svc.getStatus().phase).toBe('running');

    release();
    await settle();
    expect(svc.getStatus().phase).toBe('idle');
    // Released, so the next pass may start.
    expect(svc.start('metadata-optimize', q)).toBe('started');
  });

  it('cancel flips shouldStop and settles as cancelled', async () => {
    let saw = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = svcWith(
      fakeTask(async (ctx) => {
        await gate;
        saw = ctx.shouldStop();
      }),
    );

    svc.start('metadata-optimize', q);
    expect(svc.cancel()).toBe(true);
    expect(svc.getStatus().phase).toBe('cancelling');

    release();
    await settle();
    expect(saw).toBe(true);
    const s = svc.getStatus();
    expect(s.phase).toBe('idle');
    expect(s.lastOutcome).toBe('cancelled');
  });

  it('cancel reports false when nothing is running', () => {
    expect(svcWith(fakeTask(async () => {})).cancel()).toBe(false);
  });

  it('a cancel does not disarm the next pass', async () => {
    const stopSeen: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = svcWith(
      fakeTask(async (ctx) => {
        await gate;
        stopSeen.push(ctx.shouldStop());
      }),
    );
    svc.start('metadata-optimize', q);
    svc.cancel();
    release();
    await settle();

    // Second pass: the token must have been cleared at run start.
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    const svc2 = svcWith(
      fakeTask(async (ctx) => {
        await gate2;
        stopSeen.push(ctx.shouldStop());
      }),
    );
    svc2.start('metadata-optimize', q);
    release2();
    await settle();
    expect(stopSeen).toEqual([true, false]);
  });

  it('accumulates progress and caps lastItems at 12', async () => {
    const svc = svcWith(
      fakeTask(async (ctx) => {
        for (let i = 1; i <= 15; i++) ctx.onProgress({ total: 15, visited: i, label: `item-${i}` });
      }),
    );
    svc.start('metadata-optimize', q);
    await settle();
    const s = svc.getStatus();
    expect(s.total).toBe(15);
    expect(s.visited).toBe(15);
    expect(s.lastItems).toHaveLength(12);
    expect(s.lastItems[0]).toBe('item-4');
    expect(s.lastItems.at(-1)).toBe('item-15');
    expect(s.detail).toEqual({ checked: 1 });
    expect(s.lastOutcome).toBe('completed');
  });

  it('a throwing pass releases the guard and records the error', async () => {
    const svc = svcWith(
      fakeTask(async () => {
        throw new Error('lidarr exploded');
      }),
    );
    svc.start('metadata-optimize', q);
    await settle();
    const s = svc.getStatus();
    expect(s.phase).toBe('idle');
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastError).toBe('lidarr exploded');
    // The guard released, so the admin can retry rather than being locked out.
    expect(svc.start('metadata-optimize', q)).toBe('started');
  });

  it('carries the task describe() summary onto the status', async () => {
    const svc = svcWith(
      fakeTask(async () => {}, { describe: () => ({ summary: 'dry-run all', dryRun: true }) }),
    );
    svc.start('metadata-optimize', q, 'admin@example.com');
    const s = svc.getStatus();
    expect(s.dryRun).toBe(true);
    expect(s.params).toBe('dry-run all');
    expect(s.startedBy).toBe('admin@example.com');
    await settle();
  });
});
