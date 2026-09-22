import { describe, expect, it } from 'bun:test';
import { freeformAtom, readFreeformAtoms, withFreeformAtoms } from './mp4-freeform.js';

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A structurally valid skeleton: `ftyp`, `mdat`, then `moov/udta/meta/ilst` — or `moov` first. */
function mp4(ilstItems: Buffer[], opts: { moovFirst?: boolean } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0'));
  const mdat = box('mdat', Buffer.alloc(64, 0xaa));
  const hdlr = box('hdlr', Buffer.alloc(25));
  const meta = box('meta', Buffer.alloc(4), hdlr, box('ilst', ...ilstItems));
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), box('udta', meta));
  return Buffer.concat(opts.moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

const title = box('©nam', box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from('T')));

function values(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const atom of readFreeformAtoms(buf)) {
    // mean(28) + name(12+n) + data(16+v), each after the 8-byte `----` header.
    const nameSize = atom.readUInt32BE(8 + 28);
    const name = atom.toString('utf8', 8 + 28 + 12, 8 + 28 + nameSize);
    const dataOffset = 8 + 28 + nameSize;
    out[name] = atom.toString('utf8', dataOffset + 16, atom.length);
  }
  return out;
}

describe('withFreeformAtoms (#1274)', () => {
  it('appends values and grows every enclosing box by the same amount', () => {
    const before = mp4([title]);
    const after = withFreeformAtoms(before, [], { initialkey: 'Am', ENERGY: '0.750' })!;
    expect(after).not.toBeNull();
    expect(values(after)).toEqual({ initialkey: 'Am', ENERGY: '0.750' });
    // mdat precedes moov, so its bytes — and every chunk offset into it — are untouched.
    expect(after.subarray(0, 16 + 72)).toEqual(before.subarray(0, 16 + 72));
    const moovSize = after.readUInt32BE(16 + 72);
    expect(16 + 72 + moovSize).toBe(after.length);
  });

  it('keeps carried atoms and lets a value replace a carried one of the same name', () => {
    const carried = [
      freeformAtom('MusicBrainz Artist Id', 'artist-1'),
      freeformAtom('initialkey', 'C'),
    ];
    const after = withFreeformAtoms(mp4([title]), carried, { initialkey: 'Am' })!;
    expect(values(after)).toEqual({ 'MusicBrainz Artist Id': 'artist-1', initialkey: 'Am' });
  });

  it('is idempotent: rewriting a written file leaves one atom per name', () => {
    const once = withFreeformAtoms(mp4([title]), [], { initialkey: 'Am' })!;
    const twice = withFreeformAtoms(once, readFreeformAtoms(once), { initialkey: 'Bm' })!;
    expect(readFreeformAtoms(twice)).toHaveLength(1);
    expect(values(twice)).toEqual({ initialkey: 'Bm' });
  });

  it('drops atoms already in the target ilst in favour of the carried set', () => {
    const target = mp4([title, freeformAtom('stale', 'x')]);
    expect(values(withFreeformAtoms(target, [], { a: '1' })!)).toEqual({ a: '1' });
  });

  it('refuses a moov-first (faststart) file rather than shifting mdat under its chunk offsets', () => {
    expect(
      withFreeformAtoms(mp4([title], { moovFirst: true }), [], { initialkey: 'Am' }),
    ).toBeNull();
  });

  it('refuses a file with no ilst and a truncated one', () => {
    const noIlst = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', box('mvhd', Buffer.alloc(8))),
    ]);
    expect(withFreeformAtoms(noIlst, [], { a: '1' })).toBeNull();
    const good = mp4([title]);
    expect(withFreeformAtoms(good.subarray(0, good.length - 3), [], { a: '1' })).toBeNull();
  });
});
