/**
 * Hardware + load snapshot for the Admin "ServiceReview" resource.
 *
 * Plain `node:os` primitives are used for system totals (CPU jiffies across
 * `user/nice/sys/idle/irq`, memory bytes); the same delta technique every
 * standard system-monitor uses (no new dependency). The GPU probe is the
 * portable-by-shell part — try `nvidia-smi`/`rocm-smi` on Linux & Windows,
 * `system_profiler` on macOS, with a bounded 500 ms kill per probe. When no
 * vendor tool is available the GPU snapshot is `null` and the route quietly
 * omits it; the UI then hides the pill (no "N/A" string to lie to the user).
 *
 * Everything here is best-effort: a thrown `os.cpus()` returns zeros in that
 * field rather than dropping the whole resource. The `gpuCache` short-circuits
 * repeat probes so a 5 s poll doesn't shell out 12 times a minute when nothing
 * is connected to the dGPU.
 */
import { cpus, platform, totalmem, freemem, arch } from 'node:os';
import { spawn } from 'node:child_process';

export interface CpuSnapshot {
  /** 0..100 system-wide utilisation since the previous call. 0 on the first call. */
  percent: number;
  /** Total logical cores (incl. hyperthreads). */
  cores: number;
  /** CPU model string (the first core's), trimmed. */
  model: string;
}

export interface MemorySnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** NicotinD process RSS — what the server is actually holding. */
  processRssBytes: number;
  /** NicotinD process V8 heap-used — distinct from RSS, useful for memory leaks. */
  processHeapBytes: number;
}

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown';

export interface GpuSnapshot {
  vendor: GpuVendor;
  /** 0..100, undefined when the vendor CLI doesn't expose utilisation (Apple). */
  percent?: number;
  /** Display name from the vendor tool (best-effort). */
  name?: string;
  /** Bytes, undefined when not exposed. */
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
}

export interface HardwareSnapshot {
  cpuModel: string;
  cores: number;
  arch: ReturnType<typeof arch>;
  platform: NodeJS.Platform;
  totalMemoryBytes: number;
  gpuDetected: { vendor: GpuVendor; name?: string } | null;
}

export interface MetricsSnapshot {
  hardware: HardwareSnapshot;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  gpu: GpuSnapshot | null;
}

type ProbeResult = GpuSnapshot | null;

interface GpuCache {
  ts: number;
  value: ProbeResult;
}

const GPU_CACHE_MS = 5_000;
const PROBE_TIMEOUT_MS = 500;
/** Module-level CPU sample carried between calls so we can compute deltas. */
let prevSample: { idle: number; total: number; cores: number } | null = null;
/** Module-level GPU cache, keyed per vendor so a clean CPU sample doesn't reset macOS. */
let gpuCache: GpuCache | null = null;

/**
 * Injectable slice of `node:os` used by `readCpu`/`readMemory`/`readHardware`.
 * Tests pass a custom implementation; production code uses `realOs` (the
 * live module). Keeping the surface small means each test can pin every
 * primitive without ever touching the real kernel.
 */
export interface OsShim {
  cpus: typeof cpus;
  totalmem: typeof totalmem;
  freemem: typeof freemem;
  arch: typeof arch;
  platform: typeof platform;
}

const realOs: OsShim = { cpus, totalmem, freemem, arch, platform };

/** Reset all module-level state — exposed for tests so each case starts cold. */
export function _resetMetricsState(opts: { os?: OsShim } = {}): void {
  if (opts.os !== undefined) currentOs = opts.os;
  prevSample = null;
  gpuCache = null;
}

let currentOs: OsShim = realOs;

/**
 * Read the current CPU snapshot and compute the delta vs the previous call.
 * First call → `percent: 0` (no baseline yet) so we never lie with a fake 100 %.
 */
export function readCpu(opts: { os?: OsShim } = {}): CpuSnapshot {
  if (opts.os) currentOs = opts.os;
  const cores = currentOs.cpus();
  const model = cores[0]?.model?.trim() || 'unknown';
  let idle = 0;
  let total = 0;
  for (const c of cores) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  let percent = 0;
  if (prevSample && prevSample.cores === cores.length && prevSample.total > 0) {
    const idleDelta = idle - prevSample.idle;
    const totalDelta = total - prevSample.total;
    if (totalDelta > 0) percent = Math.min(100, Math.max(0, Math.round(((1 - idleDelta / totalDelta) * 100) * 10) / 10));
  }
  prevSample = { idle, total, cores: cores.length };
  return { percent, cores: cores.length, model };
}

/** Read memory totals + NicotinD's own RSS + heap. */
export function readMemory(opts: { os?: OsShim } = {}): MemorySnapshot {
  if (opts.os) currentOs = opts.os;
  const total = currentOs.totalmem();
  const free = currentOs.freemem();
  const mu = process.memoryUsage();
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - free),
    freeBytes: free,
    processRssBytes: mu.rss,
    processHeapBytes: mu.heapUsed,
  };
}

/** Cheap, stable hardware description — included in every snapshot, doesn't tick. */
export function readHardware(gpu: GpuSnapshot | null, opts: { os?: OsShim } = {}): HardwareSnapshot {
  if (opts.os) currentOs = opts.os;
  const cores = currentOs.cpus();
  return {
    cpuModel: cores[0]?.model?.trim() || 'unknown',
    cores: cores.length,
    arch: currentOs.arch(),
    platform: currentOs.platform(),
    totalMemoryBytes: currentOs.totalmem(),
    gpuDetected: gpu ? { vendor: gpu.vendor, name: gpu.name } : null,
  };
}

/** Run a shell process with a hard kill timeout; returns stdout or null. */
function runProbe(cmd: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve(null);
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(t);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(t);
        resolve(out);
      });
    } catch {
      resolve(null);
    }
  });
}

/** `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` → GpuSnapshot. */
async function probeNvidia(): Promise<ProbeResult> {
  const raw = await runProbe('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total,name',
    '--format=csv,noheader,nounits',
  ]);
  if (!raw) return null;
  const line = raw.trim().split('\n')[0];
  if (!line) return null;
  const [util, memUsed, memTotal, ...nameParts] = line.split(',').map((s) => s.trim());
  const percent = Number(util);
  return {
    vendor: 'nvidia',
    percent: Number.isFinite(percent) ? percent : undefined,
    memoryUsedBytes: toMb(memUsed),
    memoryTotalBytes: toMb(memTotal),
    name: nameParts.join(', ') || undefined,
  };
}

/** `rocm-smi --csv` — parse the first `gpu%` + VRAM rows out of the text dump. */
async function probeRocm(): Promise<ProbeResult> {
  const raw = await runProbe('rocm-smi', ['--csv']);
  if (!raw) return null;
  const m = /GPU%[^]*?(\d+)[^]*?(\d+)\s*MB/i.exec(raw);
  if (!m) return null;
  return {
    vendor: 'amd',
    percent: Math.min(100, Math.max(0, Number(m[1]))),
    memoryUsedBytes: Number(m[2]) * 1024 * 1024,
  };
}

/** macOS: parse `system_profiler SPDisplaysDataType -json` for GPU name + vendor. */
async function probeMac(): Promise<ProbeResult> {
  const raw = await runProbe('system_profiler', ['SPDisplaysDataType', '-json']);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { SPDisplaysDataType?: Array<{ spdisplays_vendor?: string; spdisplays_vendor_id?: string; spdisplays_device_name?: string; _name?: string }> };
    const gpu = json.SPDisplaysDataType?.[0];
    if (!gpu) return null;
    const vendor = mapMacVendor(gpu.spdisplays_vendor, gpu.spdisplays_vendor_id);
    const name = gpu.spdisplays_device_name ?? gpu._name;
    return { vendor, name, percent: undefined };
  } catch {
    return null;
  }
}

function mapMacVendor(name?: string, hex?: string): GpuVendor {
  const n = (name ?? '').toLowerCase();
  if (n.includes('apple')) return 'apple';
  if (n.includes('amd') || n.includes('ati')) return 'amd';
  if (n.includes('intel')) return 'intel';
  if (n.includes('nvidia')) return 'nvidia';
  // Hex fallback: 0x10de=nvidia, 0x1002=amd, 0x8086=intel, 0x106b=apple.
  const id = Number(hex);
  if (id === 0x10de) return 'nvidia';
  if (id === 0x1002) return 'amd';
  if (id === 0x8086) return 'intel';
  if (id === 0x106b) return 'apple';
  return 'unknown';
}

function toMb(s: string): number | undefined {
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 1024 * 1024);
}

/**
 * One-shot cached GPU probe. Tries `nvidia-smi` → `rocm-smi` → macOS, in order,
 * caches the result for `GPU_CACHE_MS` so polls don't shell out 12 times/min.
 * Returns `null` when no vendor tool exposes utilisation (and the UI hides the
 * pill — see the design rationale in docs/design-patterns.md "ServiceReview").
 */
export async function readGpu(now: number = Date.now(), opts: { os?: OsShim; probe?: GpuProbe } = {}): Promise<ProbeResult> {
  if (opts.os) currentOs = opts.os;
  const probe = opts.probe ?? defaultProbe;
  if (gpuCache && now - gpuCache.ts < GPU_CACHE_MS) return gpuCache.value;
  let value: ProbeResult = null;
  if (currentOs.platform() === 'darwin') {
    value = await probe.mac();
  } else {
    value = await probe.nvidia();
    if (value === null) value = await probe.rocm();
  }
  gpuCache = { ts: now, value };
  return value;
}

/**
 * Pluggable GPU probe factory — `nvidia`/`rocm`/`mac` are individually
 * injectable so tests can drive each path without `nvidia-smi` on the box.
 * Production passes `defaultProbe` (the built-in shell-out, same shape).
 */
export interface GpuProbe {
  nvidia: () => Promise<ProbeResult>;
  rocm: () => Promise<ProbeResult>;
  mac: () => Promise<ProbeResult>;
}

const defaultProbe: GpuProbe = { nvidia: probeNvidia, rocm: probeRocm, mac: probeMac };

/** Collect everything in one call, with a graceful degrade for any failing piece. */
export async function collectMetrics(opts: { os?: OsShim; probe?: GpuProbe; gpuCacheTtlMs?: number } = {}): Promise<MetricsSnapshot> {
  if (opts.os) currentOs = opts.os;
  let gpu: GpuSnapshot | null = null;
  try {
    gpu = await readGpu(Date.now(), { probe: opts.probe });
  } catch {
    gpu = null;
  }
  return {
    hardware: readHardware(gpu, { os: currentOs }),
    cpu: readCpu({ os: currentOs }),
    memory: readMemory({ os: currentOs }),
    gpu,
  };
}
