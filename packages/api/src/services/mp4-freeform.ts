import { readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '@nicotind/core';

const log = createLogger('mp4-freeform');

/**
 * MP4 freeform (`----`) atoms, written by hand because ffmpeg will not (#1274).
 *
 * ffmpeg's `ipod` muxer has a fixed atom vocabulary. A `-metadata` key outside
 * it is dropped with exit 0, and so is every `----:com.apple.iTunes:NAME` the
 * *source* already carried — a retag of any `.m4a` stripped the MusicBrainz ids
 * another tagger had written, as well as the eleven fields this app could never
 * write in the first place. music-metadata reads these atoms fine, so the gap
 * was write-only.
 *
 * **Why this is safe without touching the sample tables.** Growing `ilst` grows
 * `moov`, and anything after `moov` moves. If `mdat` came after it, every
 * `stco`/`co64` chunk offset would have to be patched. ffmpeg's default output
 * (no `+faststart`) puts `moov` **last**, so nothing follows it and no offset
 * moves. This module only runs on that shape and refuses any other, rather
 * than learning to patch sample tables for a case the writer never produces.
 */

const ITUNES_MEAN = 'com.apple.iTunes';

/** `data` atom type 1: UTF-8 text, per the iTunes metadata well-known types. */
const DATA_TYPE_UTF8 = 1;

interface Atom {
  type: string;
  offset: number;
  size: number;
}

/** Direct children of the box spanning `[start, end)`. `null` on a malformed or 64-bit size. */
function children(buf: Buffer, start: number, end: number): Atom[] | null {
  const out: Atom[] = [];
  let o = start;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    // 0 ("to end of file") and 1 (64-bit largesize) never occur on the
    // metadata boxes ffmpeg writes; refusing them keeps the size arithmetic
    // below 32-bit and honest.
    if (size < 8 || o + size > end) return null;
    out.push({ type: buf.toString('latin1', o + 4, o + 8), offset: o, size });
    o += size;
  }
  return o === end ? out : null;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A `----` atom holding one UTF-8 value under `com.apple.iTunes:<name>`. */
export function freeformAtom(name: string, value: string): Buffer {
  const fullBoxHeader = Buffer.alloc(4);
  const dataHeader = Buffer.alloc(8);
  dataHeader.writeUInt32BE(DATA_TYPE_UTF8, 0);
  return box(
    '----',
    box('mean', fullBoxHeader, Buffer.from(ITUNES_MEAN, 'utf8')),
    box('name', fullBoxHeader, Buffer.from(name, 'utf8')),
    box('data', dataHeader, Buffer.from(value, 'utf8')),
  );
}

/** `mean:name` of a raw `----` atom, or `null` if it is not one. */
function freeformKey(atom: Buffer): string | null {
  const parts = children(atom, 8, atom.length);
  if (!parts) return null;
  let mean: string | undefined;
  let name: string | undefined;
  for (const p of parts) {
    // Both are full boxes: 4 bytes of version/flags before the text.
    const text = atom.toString('utf8', p.offset + 12, p.offset + p.size);
    if (p.type === 'mean') mean = text;
    else if (p.type === 'name') name = text;
  }
  return mean !== undefined && name !== undefined ? `${mean}:${name}` : null;
}

interface IlstPath {
  /** Boxes from `moov` down to `ilst`, outermost first — every size that grows. */
  chain: Atom[];
  ilst: Atom;
}

/**
 * Locate `moov/udta/meta/ilst`. `null` when any link is missing or `moov` is
 * not the file's last top-level box (see the module comment for why that is
 * the precondition, not a limitation to be worked around).
 */
function findIlst(buf: Buffer): IlstPath | null {
  const top = children(buf, 0, buf.length);
  if (!top || top.length === 0) return null;
  const moov = top[top.length - 1]!;
  if (moov.type !== 'moov') return null;
  const udta = children(buf, moov.offset + 8, moov.offset + moov.size)?.find(
    (a) => a.type === 'udta',
  );
  if (!udta) return null;
  const meta = children(buf, udta.offset + 8, udta.offset + udta.size)?.find(
    (a) => a.type === 'meta',
  );
  if (!meta) return null;
  // `meta` is a full box: its children start after 4 bytes of version/flags.
  const ilst = children(buf, meta.offset + 12, meta.offset + meta.size)?.find(
    (a) => a.type === 'ilst',
  );
  if (!ilst) return null;
  return { chain: [moov, udta, meta, ilst], ilst };
}

/** Every raw `----` atom in a file's `ilst`, in order. Empty when there is no `ilst`. */
export function readFreeformAtoms(buf: Buffer): Buffer[] {
  const top = children(buf, 0, buf.length);
  const moov = top?.find((a) => a.type === 'moov');
  if (!moov) return [];
  const udta = children(buf, moov.offset + 8, moov.offset + moov.size)?.find(
    (a) => a.type === 'udta',
  );
  const meta =
    udta && children(buf, udta.offset + 8, udta.offset + udta.size)?.find((a) => a.type === 'meta');
  const ilst =
    meta &&
    children(buf, meta.offset + 12, meta.offset + meta.size)?.find((a) => a.type === 'ilst');
  if (!ilst) return [];
  const items = children(buf, ilst.offset + 8, ilst.offset + ilst.size) ?? [];
  return items
    .filter((a) => a.type === '----')
    .map((a) => Buffer.from(buf.subarray(a.offset, a.offset + a.size)));
}

/**
 * Replace a file's freeform atoms with `carried` (raw atoms, typically read
 * from the file before ffmpeg rewrote it) overlaid by `values`. A value for a
 * name that is also carried **replaces** it, so a rewrite never leaves two
 * atoms for one field. Pure: returns the new buffer, or `null` when the file
 * does not have the shape this can edit safely.
 */
export function withFreeformAtoms(
  buf: Buffer,
  carried: readonly Buffer[],
  values: Readonly<Record<string, string>>,
): Buffer | null {
  const found = findIlst(buf);
  if (!found) return null;
  const { chain, ilst } = found;
  const items = children(buf, ilst.offset + 8, ilst.offset + ilst.size);
  if (!items) return null;

  const replaced = new Set(Object.keys(values).map((n) => `${ITUNES_MEAN}:${n}`));
  const kept = items
    .filter((a) => a.type !== '----')
    .map((a) => buf.subarray(a.offset, a.offset + a.size));
  const carriedKept = carried.filter((a) => {
    const key = freeformKey(a);
    return key !== null && !replaced.has(key);
  });
  const written = Object.entries(values).map(([name, value]) => freeformAtom(name, value));
  const body = Buffer.concat([...kept, ...carriedKept, ...written]);

  const delta = 8 + body.length - ilst.size;
  const out = Buffer.concat([
    buf.subarray(0, ilst.offset + 8),
    body,
    buf.subarray(ilst.offset + ilst.size),
  ]);
  for (const a of chain) {
    const size = a.size + delta;
    if (size > 0xffffffff) return null;
    out.writeUInt32BE(size, a.offset);
  }
  return out;
}

/**
 * {@link withFreeformAtoms} applied to a file in place. `false` — never a
 * throw — when the file cannot be edited safely, so the caller reports the
 * write as failed instead of claiming fields it did not land.
 */
export function writeFreeformAtoms(
  path: string,
  carried: readonly Buffer[],
  values: Readonly<Record<string, string>>,
): boolean {
  try {
    const next = withFreeformAtoms(readFileSync(path), carried, values);
    if (!next) {
      log.warn(
        { path },
        'mp4 layout not editable (moov not last, or no ilst); freeform atoms not written',
      );
      return false;
    }
    writeFileSync(path, next);
    return true;
  } catch (err) {
    log.warn({ err, path }, 'mp4 freeform write failed');
    return false;
  }
}
