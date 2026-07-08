import type {
  SlskdApplicationInfo,
  SlskdLimits,
  SlskdServerState,
  SlskdSpeeds,
  SlskdStatus,
  SlskdTransferCounts,
  SlskdUserTransferGroup,
} from '@nicotind/core';

/**
 * Pure roll-up of slskd data into the extension status panel's shape. Kept
 * DI-free and side-effect-free so it unit-tests without a live slskd — the route
 * fetches the raw pieces (server state, transfer groups, options JSON, app info)
 * and hands them here. Every input is optional/nullable because slskd may be
 * mid-connect or an individual probe may fail; the aggregate degrades to zeros
 * rather than throwing.
 */

/** In-progress transfer states contribute to live speed; queued states to the queue count. */
const IN_PROGRESS = new Set(['InProgress', 'Initializing']);
const QUEUED = new Set(['Queued, Locally', 'Queued, Remotely', 'Requested']);

function iterTransfers(groups: SlskdUserTransferGroup[] | null | undefined) {
  const out: { state: string; averageSpeed: number }[] = [];
  for (const group of groups ?? []) {
    for (const dir of group.directories) {
      for (const f of dir.files) out.push({ state: f.state, averageSpeed: f.averageSpeed });
    }
  }
  return out;
}

/** Sum in-progress `averageSpeed` (bytes/sec) across all transfers in the groups. */
export function sumInProgressSpeed(groups: SlskdUserTransferGroup[] | null | undefined): number {
  return iterTransfers(groups)
    .filter((t) => IN_PROGRESS.has(t.state))
    .reduce((acc, t) => acc + (t.averageSpeed || 0), 0);
}

export function computeCounts(
  downloads: SlskdUserTransferGroup[] | null | undefined,
  uploads: SlskdUserTransferGroup[] | null | undefined,
): SlskdTransferCounts {
  const d = iterTransfers(downloads);
  const u = iterTransfers(uploads);
  return {
    downloading: d.filter((t) => IN_PROGRESS.has(t.state)).length,
    uploading: u.filter((t) => IN_PROGRESS.has(t.state)).length,
    queued: [...d, ...u].filter((t) => QUEUED.has(t.state)).length,
  };
}

/** Read a nested numeric field from an untyped record, tolerating missing paths. */
function num(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : undefined;
}

/**
 * Best-effort extraction of global limits from slskd's options JSON. slskd
 * serializes these under `global.upload/download.{slots,speedLimit}`; we probe a
 * couple of plausible shapes and leave anything unresolved `undefined` (the UI
 * renders "—"). Speed limits are KiB/s in slskd's model; 0 = unlimited.
 */
export function extractSlskdLimits(options: Record<string, unknown> | null | undefined): SlskdLimits {
  if (!options) return {};
  return {
    uploadSlots: num(options, 'global', 'upload', 'slots') ?? num(options, 'uploads', 'slots'),
    downloadSlots:
      num(options, 'global', 'download', 'slots') ?? num(options, 'downloads', 'slots'),
    uploadSpeedLimit:
      num(options, 'global', 'upload', 'speedLimit') ?? num(options, 'uploads', 'speedLimit'),
    downloadSpeedLimit:
      num(options, 'global', 'download', 'speedLimit') ?? num(options, 'downloads', 'speedLimit'),
  };
}

export interface SlskdStatusInputs {
  enabled: boolean;
  available: boolean;
  serverState: SlskdServerState | null;
  downloads: SlskdUserTransferGroup[] | null;
  uploads: SlskdUserTransferGroup[] | null;
  options: Record<string, unknown> | null;
  appInfo: SlskdApplicationInfo | null;
}

/** Assemble the full status object from the fetched pieces (all failure-tolerant). */
export function buildSlskdStatus(inputs: SlskdStatusInputs): SlskdStatus {
  const speeds: SlskdSpeeds = {
    downloadBytesPerSec: sumInProgressSpeed(inputs.downloads),
    uploadBytesPerSec: sumInProgressSpeed(inputs.uploads),
  };
  return {
    enabled: inputs.enabled,
    available: inputs.available,
    // Prefer the richer application `server` block, else the dedicated state probe.
    connection: inputs.appInfo?.server ?? inputs.serverState ?? null,
    speeds,
    counts: computeCounts(inputs.downloads, inputs.uploads),
    limits: extractSlskdLimits(inputs.options),
    shares: inputs.appInfo?.shares ?? {},
    version: inputs.appInfo?.version,
    uptimeSeconds: inputs.appInfo?.uptime,
  };
}
