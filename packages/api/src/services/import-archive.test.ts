import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import {
  ArchiveError,
  archiveDisplayName,
  archiveEntryRel,
  assertArchiveWithinLimits,
  extractZipEntry,
  looksLikeArchive,
  readZipCentralDirectory,
  safeArchivePath,
  type ZipEntry,
} from './import-archive.js';

/* ── Fixtures are BUILT here, never committed as binaries ───────────────────
 * A hand-written writer is the only way to produce the shapes that matter:
 * a data-descriptor entry (zeroed LOCAL sizes), a symlink entry, an encrypted
 * flag, a traversing name. `zip(1)` cannot be asked for most of them, and a
 * committed .zip blob would be unreadable in review.
 */

interface FixtureEntry {
  name: string;
  data?: Buffer;
  /** 0 = stored, 8 = deflate (default). */
  method?: number;
  /** Zero the LOCAL header's sizes, as a streaming zipper does (GP bit 3). */
  dataDescriptor?: boolean;
  encrypted?: boolean;
  symlink?: boolean;
  /** Override what the CENTRAL directory claims the entry expands to. */
  declaredUncompressed?: number;
}

function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(e.name, 'utf8');
    let flags = 0;
    if (e.dataDescriptor) flags |= 0x8;
    if (e.encrypted) flags |= 0x1;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.dataDescriptor ? 0 : crc32(raw), 14);
    local.writeUInt32LE(e.dataDescriptor ? 0 : body.length, 18);
    local.writeUInt32LE(e.dataDescriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.declaredUncompressed ?? raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // Unix mode in the high 16 bits: 0o120777 marks a symlink.
    central.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

let dir: string;
const zipAt = (name: string, entries: FixtureEntry[]): string => {
  const path = join(dir, name);
  writeFileSync(path, buildZip(entries));
  return path;
};
const entryNamed = (path: string, name: string): ZipEntry =>
  readZipCentralDirectory(path).find((e) => e.name === name)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nicotind-zip-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readZipCentralDirectory', () => {
  it('enumerates stored and deflated entries with their real sizes', () => {
    const path = zipAt('a.zip', [
      { name: 'Album/01.flac', data: Buffer.alloc(8000, 7), method: 8 },
      { name: 'Album/cover.jpg', data: Buffer.from('jpegbytes'), method: 0 },
    ]);
    const entries = readZipCentralDirectory(path);
    expect(entries.map((e) => e.name)).toEqual(['Album/01.flac', 'Album/cover.jpg']);
    expect(entries[0]!.uncompressedSize).toBe(8000);
    expect(entries[0]!.method).toBe(8);
    expect(entries[1]!.method).toBe(0);
  });

  it('marks directory, symlink and encrypted entries for the caller to skip', () => {
    const path = zipAt('b.zip', [
      { name: 'Album/', data: Buffer.alloc(0), method: 0 },
      { name: 'Album/link.flac', data: Buffer.from('/etc/shadow'), method: 0, symlink: true },
      { name: 'Album/secret.mp3', data: Buffer.from('x'), method: 0, encrypted: true },
    ]);
    const [d, link, secret] = readZipCentralDirectory(path);
    expect(d!.isDirectory).toBe(true);
    expect(link!.isSymlink).toBe(true);
    expect(secret!.isEncrypted).toBe(true);
  });

  /**
   * `cdSize`/`cdOffset` are 32-bit fields read straight out of the trailer and
   * used as an allocation size and a seek offset. Unbounded, a 30-byte file
   * claiming a 4 GiB directory makes the server allocate and read 4 GiB.
   */
  it('refuses a directory that points outside the file, rather than allocating it', () => {
    const buf = buildZip([{ name: 'x.mp3', data: Buffer.from('x'), method: 0 }]);
    buf.writeUInt32LE(0x0f000000, buf.length - 22 + 12); // cdSize ≈ 250 MB
    const path = join(dir, 'huge-cd.zip');
    writeFileSync(path, buf);
    try {
      readZipCentralDirectory(path);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ArchiveError).code).toBe('ARCHIVE_UNREADABLE');
    }
  });

  it('refuses a file that is not a ZIP at all', () => {
    const path = join(dir, 'nope.zip');
    writeFileSync(path, 'just some text, definitely not a zip');
    expect(() => readZipCentralDirectory(path)).toThrow(ArchiveError);
    try {
      readZipCentralDirectory(path);
    } catch (err) {
      expect((err as ArchiveError).code).toBe('ARCHIVE_UNREADABLE');
    }
  });

  /** Reading a sentinel as a real offset is a corrupt read; refusing is honest. */
  it('refuses ZIP64 rather than misreading its sentinel offsets', () => {
    const buf = buildZip([{ name: 'x.mp3', data: Buffer.from('x'), method: 0 }]);
    buf.writeUInt32LE(0xffffffff, buf.length - 22 + 16); // cd offset sentinel
    const path = join(dir, 'z64.zip');
    writeFileSync(path, buf);
    try {
      readZipCentralDirectory(path);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ArchiveError).code).toBe('ARCHIVE_UNSUPPORTED');
    }
  });
});

describe('assertArchiveWithinLimits', () => {
  it('accepts a normal music archive (audio barely compresses)', () => {
    const path = zipAt('ok.zip', [{ name: 'a.flac', data: randomBytes(4096) }]);
    expect(() => assertArchiveWithinLimits(readZipCentralDirectory(path))).not.toThrow();
  });

  /** A small, highly-compressible archive is harmless — don't cry bomb. */
  it('accepts a tiny archive with an extreme ratio', () => {
    const path = zipAt('silence.zip', [{ name: 'a.wav', data: Buffer.alloc(5000) }]);
    expect(() => assertArchiveWithinLimits(readZipCentralDirectory(path))).not.toThrow();
  });

  /**
   * The whole point of reading the central directory first: a bomb's size on
   * disk says nothing, but its declared expansion does — and we learn it
   * before writing a single byte.
   */
  it('refuses a declared expansion no real music archive could have', () => {
    const path = zipAt('bomb.zip', [
      { name: 'a.mp3', data: Buffer.alloc(64, 0), declaredUncompressed: 512 * 1024 * 1024 },
    ]);
    try {
      assertArchiveWithinLimits(readZipCentralDirectory(path));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ArchiveError).code).toBe('ARCHIVE_TOO_LARGE');
    }
  });
});

describe('safeArchivePath', () => {
  const root = () => join(dir, 'staging');

  it('keeps the nested path — flattening would destroy album grouping', () => {
    expect(safeArchivePath(root(), 'Album/CD1/01.flac')).toBe(
      join(root(), 'Album', 'CD1', '01.flac'),
    );
  });

  it('normalizes Windows separators the way a zip may store them', () => {
    expect(safeArchivePath(root(), 'Album\\CD1\\01.flac')).toBe(
      join(root(), 'Album', 'CD1', '01.flac'),
    );
  });

  // Every one of these extracts to an attacker-chosen path through an
  // unguarded reader — a central directory stores names verbatim.
  it.each(['../../etc/evil.mp3', '/abs/evil.mp3', 'Album/../../out.mp3', '..', ''])(
    'refuses the hostile entry name %p',
    (name) => {
      expect(() => safeArchivePath(root(), name)).toThrow(ArchiveError);
    },
  );
});

describe('extractZipEntry', () => {
  it('round-trips a deflated entry byte for byte', async () => {
    const data = Buffer.from('a'.repeat(5000) + 'tail');
    const path = zipAt('c.zip', [{ name: 'Album/01.flac', data, method: 8 }]);
    const out = join(dir, 'out.flac');
    await extractZipEntry(path, entryNamed(path, 'Album/01.flac'), out);
    expect(readFileSync(out).equals(data)).toBe(true);
  });

  it('round-trips a stored entry', async () => {
    const data = Buffer.from('stored bytes');
    const path = zipAt('d.zip', [{ name: 'x.mp3', data, method: 0 }]);
    const out = join(dir, 'x.mp3');
    await extractZipEntry(path, entryNamed(path, 'x.mp3'), out);
    expect(readFileSync(out).equals(data)).toBe(true);
  });

  /**
   * The reason every size is read from the central directory: a streaming
   * zipper zeroes the LOCAL header's sizes and only the central copy is true.
   */
  it('extracts a data-descriptor entry, whose local header lies about its size', async () => {
    const data = Buffer.from('b'.repeat(3000));
    const path = zipAt('e.zip', [{ name: 'y.mp3', data, method: 8, dataDescriptor: true }]);
    const out = join(dir, 'y.mp3');
    await extractZipEntry(path, entryNamed(path, 'y.mp3'), out);
    expect(readFileSync(out).equals(data)).toBe(true);
  });

  it('refuses an encrypted entry before inflating anything', async () => {
    const path = zipAt('f.zip', [
      { name: 'z.mp3', data: Buffer.from('x'), method: 0, encrypted: true },
    ]);
    const out = join(dir, 'z.mp3');
    await expect(extractZipEntry(path, entryNamed(path, 'z.mp3'), out)).rejects.toThrow(
      /password-protected/,
    );
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an unsupported compression method', async () => {
    const path = zipAt('g.zip', [{ name: 'w.mp3', data: Buffer.from('x'), method: 0 }]);
    const entry = { ...entryNamed(path, 'w.mp3'), method: 99 };
    await expect(extractZipEntry(path, entry, join(dir, 'w.mp3'))).rejects.toThrow(
      /unsupported compression/,
    );
  });

  /**
   * The declared sizes are attacker-controlled and are what BOTH the bomb guard
   * and the import's disk preflight are computed from. Bounding the write at the
   * declared size is what makes an understatement detectable at the moment it is
   * told, rather than after the disk is full.
   */
  it('refuses an entry that expands past the size it declares', async () => {
    const data = Buffer.alloc(4000, 1);
    const path = zipAt('lie.zip', [{ name: 'big.mp3', data, method: 8, declaredUncompressed: 10 }]);
    const out = join(dir, 'big.mp3');
    try {
      await extractZipEntry(path, entryNamed(path, 'big.mp3'), out);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ArchiveError).code).toBe('ARCHIVE_TOO_LARGE');
    }
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an entry that yields fewer bytes than it declares', async () => {
    const data = Buffer.from('short');
    const path = zipAt('trunc.zip', [
      { name: 'x.mp3', data, method: 0, declaredUncompressed: 999 },
    ]);
    const out = join(dir, 'x.mp3');
    await expect(extractZipEntry(path, entryNamed(path, 'x.mp3'), out)).rejects.toThrow(
      /declares 999/,
    );
    expect(existsSync(out)).toBe(false);
  });

  /** A silently corrupt track reaching the library is worse than a failed import. */
  it('refuses an entry whose bytes do not match its declared CRC', async () => {
    const data = Buffer.from('the real content');
    const path = zipAt('badcrc.zip', [{ name: 'c.mp3', data, method: 0 }]);
    const entry = { ...entryNamed(path, 'c.mp3'), crc: 0xdeadbeef };
    const out = join(dir, 'c.mp3');
    await expect(extractZipEntry(path, entry, out)).rejects.toThrow(/CRC/);
    expect(existsSync(out)).toBe(false);
  });

  it('leaves no partial file behind when the stream fails', async () => {
    // Truly incompressible, so the deflate payload stays ~4 KB and the
    // corruption below lands in it rather than in the trailing headers.
    const data = randomBytes(4000);
    const path = zipAt('h.zip', [{ name: 'v.mp3', data, method: 8 }]);
    // Set the deflate stream's first byte to an invalid block type (BTYPE=11),
    // which inflate must reject. Its offset is the 30-byte local header plus
    // the 5-byte name. (Corrupting the *payload* of a stored block would not
    // fail — random data deflates to stored blocks, whose bytes are unchecked.)
    const buf = readFileSync(path);
    buf[30 + 'v.mp3'.length] = 0x07;
    writeFileSync(path, buf);
    const out = join(dir, 'v.mp3');
    await expect(extractZipEntry(path, entryNamed(path, 'v.mp3'), out)).rejects.toThrow(
      ArchiveError,
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe('archive path helpers', () => {
  it('recognises only the formats we can actually read', () => {
    expect(looksLikeArchive('/x/Album.zip')).toBe(true);
    expect(looksLikeArchive('/x/Album.ZIP')).toBe(true);
    expect(looksLikeArchive('/x/Album.rar')).toBe(false);
    expect(looksLikeArchive('/x/Album')).toBe(false);
  });

  it('names an archive by its stem, so the card is not "Album.zip"', () => {
    expect(archiveDisplayName('/mnt/in/Bootleg Rips 2019.zip')).toBe('Bootleg Rips 2019');
  });

  it('normalizes an entry name to a posix relative path', () => {
    expect(archiveEntryRel('Album\\CD1\\01.flac')).toBe('Album/CD1/01.flac');
    expect(archiveEntryRel('./Album/01.flac')).toBe('Album/01.flac');
  });
});

describe('mkdir sanity for nested extraction', () => {
  it('writes into a nested staging tree the caller created', async () => {
    const data = Buffer.from('nested');
    const path = zipAt('i.zip', [{ name: 'Album/CD1/01.flac', data, method: 8 }]);
    const out = join(dir, 'staging', 'Album', 'CD1', '01.flac');
    mkdirSync(join(dir, 'staging', 'Album', 'CD1'), { recursive: true });
    await extractZipEntry(path, entryNamed(path, 'Album/CD1/01.flac'), out);
    expect(readFileSync(out).equals(data)).toBe(true);
  });
});
