import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FfmpegSlots, ffmpegSlots, resolveFfmpegSlotCount } from './ffmpeg-slots.js';
import { execFileAsync } from './exec-file.js';
import { ffmpegAvailable, transcodeToFile } from './transcode.js';
import { streamPcm } from './track-analysis.js';
import { tmpdir } from 'node:os';

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FfmpegSlots', () => {
  it('never runs more than `size` at once', async () => {
    const slots = new FfmpegSlots(3);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        slots.run(i % 2 ? 'batch' : 'interactive', async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(slots.stats()).toEqual({ active: 0, activeBatch: 0, waiting: 0 });
  });

  it('batch holds at most size - 1 slots, so a batch flood never delays an interactive caller', async () => {
    const slots = new FfmpegSlots(4);
    const hold = gate();
    const flood = Array.from({ length: 50 }, () => slots.run('batch', () => hold.p));
    await tick();
    expect(slots.stats()).toEqual({ active: 3, activeBatch: 3, waiting: 47 });

    let started = false;
    const interactive = slots.run('interactive', async () => {
      started = true;
    });
    // Granted synchronously on the reserved slot: no batch slot had to free.
    await interactive;
    expect(started).toBe(true);
    expect(slots.stats().activeBatch).toBe(3);

    hold.open();
    await Promise.all(flood);
  });

  it('when every slot is busy, an interactive caller waits for exactly one release, ahead of queued batch', async () => {
    const slots = new FfmpegSlots(4);
    const holds = Array.from({ length: 4 }, gate);
    const order: string[] = [];
    const busy = [
      ...holds.slice(0, 3).map((g) => slots.run('batch', () => g.p)),
      slots.run('interactive', () => holds[3]!.p),
    ];
    const queuedBatch = Array.from({ length: 20 }, (_, i) =>
      slots.run('batch', async () => {
        order.push(`batch${i}`);
      }),
    );
    await tick();
    const interactive = slots.run('interactive', async () => {
      order.push('interactive');
    });
    await tick();
    expect(order).toEqual([]);

    holds[0]!.open(); // one batch slot frees
    await interactive;
    expect(order[0]).toBe('interactive');

    for (const g of holds) g.open();
    await Promise.all([...busy, ...queuedBatch]);
    expect(order).toHaveLength(21);
  });

  it('a nested run inside a held slot reuses it instead of deadlocking', async () => {
    const slots = new FfmpegSlots(2);
    const results = await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        slots.run('interactive', async () => {
          await tick();
          // Every slot is held here; a second acquisition would wait forever.
          return slots.run('batch', async () => i);
        }),
      ),
    );
    expect(results).toEqual([0, 1]);
    expect(slots.stats().active).toBe(0);
  });

  it('releases the slot when the work throws', async () => {
    const slots = new FfmpegSlots(2);
    await expect(
      slots.run('batch', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(slots.stats()).toEqual({ active: 0, activeBatch: 0, waiting: 0 });
  });

  it('queues batch callers in arrival order', async () => {
    const slots = new FfmpegSlots(2);
    const hold = gate();
    const order: number[] = [];
    const first = slots.run('batch', () => hold.p);
    const rest = [1, 2, 3].map((i) =>
      slots.run('batch', async () => {
        order.push(i);
      }),
    );
    hold.open();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('resolveFfmpegSlotCount', () => {
  it('uses NICOTIND_FFMPEG_SLOTS when it is an integer >= 2', () => {
    expect(resolveFfmpegSlotCount({ NICOTIND_FFMPEG_SLOTS: '6' })).toBe(6);
  });

  it('falls back to the core count (min 2) for unset or invalid values', () => {
    const fallback = resolveFfmpegSlotCount({});
    expect(fallback).toBeGreaterThanOrEqual(2);
    for (const v of ['1', '0', '-3', '2.5', 'many', '']) {
      expect(resolveFfmpegSlotCount({ NICOTIND_FFMPEG_SLOTS: v })).toBe(fallback);
    }
  });
});

describe('every ffmpeg/ffprobe child goes through the process-wide slots', () => {
  it('execFileAsync holds a slot while its child runs', async () => {
    const run = execFileAsync('sleep', ['0.2']);
    await new Promise((r) => setTimeout(r, 50));
    expect(ffmpegSlots.stats().active).toBe(1);
    await run;
    expect(ffmpegSlots.stats().active).toBe(0);
  });

  it('every service that spawns ffmpegBinary() directly wraps it in withFfmpegSlot', () => {
    const dir = import.meta.dir;
    const spawners = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.fixtures.'))
      .filter((f) => /\bspawn\(ffmpegBinary\(\)/.test(readFileSync(join(dir, f), 'utf8')));
    expect(spawners.length).toBeGreaterThanOrEqual(6);
    for (const f of spawners) {
      expect({
        f,
        wrapped: readFileSync(join(dir, f), 'utf8').includes('withFfmpegSlot('),
      }).toEqual({ f, wrapped: true });
    }
    expect(readFileSync(join(dir, 'exec-file.ts'), 'utf8')).toContain('withFfmpegSlot(');
  });

  it.skipIf(!ffmpegAvailable())(
    'a stream transcode and a waveform decode run while batch work holds every batch slot',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nd-slots-'));
      const hold = gate();
      const flood = Array.from({ length: ffmpegSlots.size * 3 }, () =>
        ffmpegSlots.run('batch', () => hold.p),
      );
      try {
        const src = join(dir, 'src.flac');
        // Interactive so the fixture itself is not stuck behind the flood.
        await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-y', src], {
          priority: 'interactive',
        });
        expect(ffmpegSlots.stats().activeBatch).toBe(ffmpegSlots.size - 1);
        await transcodeToFile(src, join(dir, 'out.mp3'), 'mp3', 128);
        let samples = 0;
        await streamPcm(src, {
          sampleRate: 8000,
          onChunk: (c) => (samples += c.length),
          priority: 'interactive',
        });
        expect(samples).toBeGreaterThan(7000);
        expect(ffmpegSlots.stats().activeBatch).toBe(ffmpegSlots.size - 1);
      } finally {
        hold.open();
        await Promise.all(flood);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
