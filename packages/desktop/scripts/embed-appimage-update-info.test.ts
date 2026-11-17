import { describe, expect, it } from 'bun:test';
import {
  UPDATE_INFO,
  fileInfo,
  findElfSection,
  rewriteFeed,
  updateInfoBytes,
} from './embed-appimage-update-info.js';

/** A minimal little-endian ELF64 image: a null section, `.upd_info` and `.shstrtab`. */
function elf(updInfoSize: number): Buffer {
  const names = Buffer.from('\0.upd_info\0.shstrtab\0', 'latin1');
  const dataAt = 0x40;
  const strAt = dataAt + updInfoSize;
  const shoff = strAt + names.length;
  const buf = Buffer.alloc(shoff + 3 * 64);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2;
  buf[5] = 1;
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(3, 0x3c);
  buf.writeUInt16LE(2, 0x3e);
  names.copy(buf, strAt);
  const section = (i: number, name: number, offset: number, size: number) => {
    const h = shoff + i * 64;
    buf.writeUInt32LE(name, h);
    buf.writeBigUInt64LE(BigInt(offset), h + 0x18);
    buf.writeBigUInt64LE(BigInt(size), h + 0x20);
  };
  section(1, 1, dataAt, updInfoSize);
  section(2, 11, strAt, names.length);
  return buf;
}

describe('findElfSection', () => {
  it('finds a named section by its file offset and size', () => {
    expect(findElfSection(elf(1024), '.upd_info')).toEqual({ offset: 0x40, size: 1024 });
  });

  it('returns null for a section the image does not carry', () => {
    expect(findElfSection(elf(1024), '.sha256_sig')).toBeNull();
  });

  it('refuses a file that is not ELF64', () => {
    expect(() => findElfSection(Buffer.alloc(128), '.upd_info')).toThrow('ELF64');
  });
});

describe('updateInfoBytes', () => {
  it('NUL-pads the string to the section size', () => {
    const out = updateInfoBytes(Buffer.alloc(1024), UPDATE_INFO);
    expect(out.length).toBe(1024);
    expect(out.toString('latin1', 0, UPDATE_INFO.length)).toBe(UPDATE_INFO);
    expect(out.subarray(UPDATE_INFO.length).every((b) => b === 0)).toBe(true);
  });

  it('refuses a section already written, so a second run cannot stack', () => {
    const used = Buffer.alloc(1024);
    used[0] = 0x67;
    expect(() => updateInfoBytes(used, UPDATE_INFO)).toThrow('already processed');
  });

  it('refuses a string that leaves no terminating NUL', () => {
    expect(() => updateInfoBytes(Buffer.alloc(8), UPDATE_INFO)).toThrow('holds 8');
  });

  it('names the release the AppImage catalog and AppImageUpdate look up', () => {
    expect(UPDATE_INFO).toBe(
      'gh-releases-zsync|kevinch3|NicotinD|latest|NicotinD-*.AppImage.zsync',
    );
  });
});

const FEED = `version: 0.8.900
files:
  - url: NicotinD-0.8.900.AppImage
    sha512: OLDSHA==
    size: 218101469
    blockMapSize: 228577
path: NicotinD-0.8.900.AppImage
sha512: OLDSHA==
releaseDate: '2026-11-17T09:39:31.829Z'
`;

describe('latest-linux.yml', () => {
  it('reads the embedded blockmap entry', () => {
    expect(fileInfo(FEED, 'NicotinD-0.8.900.AppImage')).toEqual({
      sha512: 'OLDSHA==',
      size: 218101469,
      blockMapSize: 228577,
    });
  });

  it('refuses an entry with no embedded blockmap', () => {
    expect(() =>
      fileInfo(FEED.replace('    blockMapSize: 228577\n', ''), 'NicotinD-0.8.900.AppImage'),
    ).toThrow('no embedded blockmap');
  });

  it('swaps both sha512 copies, the size and the blockmap size, and nothing else', () => {
    const prev = { sha512: 'OLDSHA==', size: 218101469, blockMapSize: 228577 };
    const out = rewriteFeed(FEED, prev, {
      sha512: 'NEWSHA==',
      size: 218101470,
      blockMapSize: 228578,
    });
    expect(out).toBe(
      FEED.replaceAll('OLDSHA==', 'NEWSHA==')
        .replace('size: 218101469', 'size: 218101470')
        .replace('blockMapSize: 228577', 'blockMapSize: 228578'),
    );
    // js-yaml (electron-updater) reads an unquoted timestamp as a Date.
    expect(out).toContain("releaseDate: '2026-11-17T09:39:31.829Z'");
  });

  it('fails loudly when the feed does not hold the values it was read with', () => {
    const prev = { sha512: 'OTHER==', size: 1, blockMapSize: 1 };
    expect(() => rewriteFeed(FEED, prev, prev)).toThrow('expected OTHER==');
  });
});
