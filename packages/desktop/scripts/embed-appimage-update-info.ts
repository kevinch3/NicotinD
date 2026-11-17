/**
 * Embed AppImageUpdate information into the built AppImage and write its `.zsync`,
 * so AppImageUpdate (and launchers that use it) can update NicotinD, not only the
 * in-app electron-updater. Run after `electron-builder --linux`, before the upload:
 *
 *   bun run packages/desktop/scripts/embed-appimage-update-info.ts [--dir release]
 *
 * WHY a post-build step: electron-builder has no option for it. Its static runtime
 * (`toolsets.appimage` in electron-builder.yml) carries an empty `.upd_info` ELF
 * section, but electron-builder then appends a blockmap to the file and records the
 * whole file's sha512/size in `latest-linux.yml`. Writing into the runtime changes
 * the first block, so the order is: strip the blockmap, write the section, rebuild
 * the blockmap with electron-builder's own `buildBlockMap`, rewrite the feed, and only
 * then make the `.zsync` of the final bytes. → docs/desktop-app.md
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { RELEASE_DIR } from './verify-published-assets.js';

export const UPDATE_INFO = 'gh-releases-zsync|kevinch3|NicotinD|latest|NicotinD-*.AppImage.zsync';

export interface Section {
  offset: number;
  size: number;
}

/** File offset and size of a named section in a little-endian ELF64 image (the AppImage runtime). */
export function findElfSection(buf: Buffer, name: string): Section | null {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1) {
    throw new Error('not a little-endian ELF64 image');
  }
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);
  const header = (i: number) => shoff + i * shentsize;
  const strtab = Number(buf.readBigUInt64LE(header(shstrndx) + 0x18));
  for (let i = 0; i < shnum; i++) {
    const h = header(i);
    const at = strtab + buf.readUInt32LE(h);
    const end = buf.indexOf(0, at);
    if (buf.toString('latin1', at, end) === name) {
      return {
        offset: Number(buf.readBigUInt64LE(h + 0x18)),
        size: Number(buf.readBigUInt64LE(h + 0x20)),
      };
    }
  }
  return null;
}

/** The bytes to write at the section: the string, NUL-padded. Refuses a section already written. */
export function updateInfoBytes(current: Buffer, info: string): Buffer {
  const bytes = Buffer.from(info, 'latin1');
  if (bytes.length >= current.length)
    throw new Error(`update info is ${bytes.length} bytes; .upd_info holds ${current.length}`);
  if (current.some((b) => b !== 0))
    throw new Error('.upd_info is not empty: the AppImage was already processed');
  return Buffer.concat([bytes, Buffer.alloc(current.length - bytes.length)]);
}

export interface FileInfo {
  sha512: string;
  size: number;
  blockMapSize: number;
}

/**
 * Swap one file's sha512/size/blockMapSize in latest-linux.yml by exact value. Not a
 * YAML round-trip: re-serialising unquotes `releaseDate`, which js-yaml (electron-updater)
 * then reads as a Date.
 */
export function rewriteFeed(feed: string, prev: FileInfo, next: FileInfo): string {
  const swap = (text: string, from: string, to: string, at: number): string => {
    const found = text.split(from).length - 1;
    if (found < at) throw new Error(`expected ${from} in the feed`);
    return text.split(from).join(to);
  };
  let out = swap(feed, prev.sha512, next.sha512, 1);
  out = swap(out, `size: ${prev.size}\n`, `size: ${next.size}\n`, 1);
  return swap(
    out,
    `blockMapSize: ${prev.blockMapSize}\n`,
    `blockMapSize: ${next.blockMapSize}\n`,
    1,
  );
}

/** electron-builder appends the deflated blockmap, then its length as a 4-byte big-endian trailer. */
export const BLOCKMAP_TRAILER = 4;

export function fileInfo(feed: string, url: string): FileInfo {
  const doc = Bun.YAML.parse(feed) as { files: Array<{ url: string } & FileInfo> };
  const entry = doc.files.find((f) => f.url === url);
  if (!entry?.blockMapSize) throw new Error(`${url} has no embedded blockmap in the feed`);
  return { sha512: entry.sha512, size: entry.size, blockMapSize: entry.blockMapSize };
}

async function main(dir: string): Promise<void> {
  const images = readdirSync(dir).filter((n) => n.endsWith('.AppImage'));
  if (images.length !== 1)
    throw new Error(`expected one AppImage in ${dir}, found ${images.length}`);
  const name = images[0]!;
  const file = join(dir, name);
  const feedPath = join(dir, 'latest-linux.yml');
  const feed = readFileSync(feedPath, 'utf8');
  const before = fileInfo(feed, name);

  const sha = new Bun.CryptoHasher('sha512').update(readFileSync(file)).digest('base64');
  if (sha !== before.sha512)
    throw new Error(`${name} does not match latest-linux.yml; rebuild before embedding`);

  const whole = readFileSync(file);
  if (whole.readUInt32BE(whole.length - BLOCKMAP_TRAILER) !== before.blockMapSize) {
    throw new Error(`${name} does not end in a ${before.blockMapSize}-byte blockmap trailer`);
  }
  truncateSync(file, before.size - before.blockMapSize - BLOCKMAP_TRAILER);
  const image = readFileSync(file);
  const section = findElfSection(image, '.upd_info');
  if (!section)
    throw new Error('the AppImage runtime has no .upd_info section (is toolsets.appimage set?)');
  const bytes = updateInfoBytes(
    image.subarray(section.offset, section.offset + section.size),
    UPDATE_INFO,
  );
  const fd = openSync(file, 'r+');
  writeSync(fd, bytes, 0, bytes.length, section.offset);
  closeSync(fd);

  // electron-builder's own blockmap writer, so the format is the one electron-updater reads.
  const req = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const { buildBlockMap } = req('app-builder-lib/out/targets/blockmap/blockmap') as {
    buildBlockMap: (file: string, format: 'deflate') => Promise<FileInfo>;
  };
  const after = await buildBlockMap(file, 'deflate');
  writeFileSync(feedPath, rewriteFeed(feed, before, after));

  const zsync = spawnSync('zsyncmake', ['-u', name, '-o', `${file}.zsync`, file], {
    stdio: 'inherit',
  });
  if (zsync.status !== 0) throw new Error(`zsyncmake exited ${zsync.status ?? zsync.error}`);
  console.log(`embedded "${UPDATE_INFO}" into ${basename(file)}; wrote ${name}.zsync`);
}

if (import.meta.main) {
  const i = process.argv.indexOf('--dir');
  await main(i === -1 ? RELEASE_DIR : process.argv[i + 1]!);
}
