/**
 * Every format the library can be standardized on must be a **valid** choice.
 *
 * #1256's requirement is that an operator picks the library's target format and
 * every option works — tags round-trip, art embeds, the ladder is calibrated.
 * The failure this prevents is not hypothetical: `FORMAT_ARGS.aac` (the
 * streaming table) emits `-f adts` with extension `.aac`, which is in
 * `AUDIO_EXTENSIONS` — so the scanner indexes it — but in neither `ID3_EXTS`
 * nor `VORBIS_EXTS`, and `writeAudioTags` returns `false` for it. Adopting that
 * entry as a library target, the obvious refactor, would have shipped a library
 * that is scanned and permanently untaggable, with every tag write silently
 * refused and no error anywhere.
 *
 * Review would have to catch that every time. This catches it once.
 *
 * Denominator discipline (docs/quality-gates.md): the set checked is
 * `LIBRARY_FORMATS` itself, read from the module rather than re-listed here, so
 * a format cannot be added without being checked. Finding zero formats is a
 * failure, not a pass — an empty registry must not read as "nothing wrong".
 */
import { AUDIO_EXTENSIONS, ID3_EXTS, VORBIS_EXTS } from '@nicotind/core';
import {
  LIBRARY_FORMATS,
  type FormatStrategy,
} from '../packages/api/src/services/library-format.js';
import { LADDERS } from '../packages/api/src/services/transcode-bitrate.js';

/**
 * Containers this app can write tags into.
 *
 * `ID3_EXTS ∪ VORBIS_EXTS` plus `.m4a`, which `writeAudioTags` handles through
 * an explicit branch rather than a set. Kept as a union of the real sets so a
 * container added there is picked up here rather than drifting.
 */
const TAGGABLE_EXTS: ReadonlySet<string> = new Set([...ID3_EXTS, ...VORBIS_EXTS, '.m4a']);

export interface FormatProblem {
  format: string;
  problem: string;
}

/** Every way a registry entry can fail to be a usable library target. */
export function problemsFor(id: string, s: FormatStrategy): FormatProblem[] {
  const out: FormatProblem[] = [];
  const add = (problem: string): void => void out.push({ format: id, problem });
  const dotted = `.${s.ext}`;

  if (s.id !== id) add(`registry key "${id}" does not match its own id "${s.id}"`);

  // Scannable: a format the scanner will not index produces a library the app
  // cannot see at all.
  if (!AUDIO_EXTENSIONS.has(dotted)) {
    add(`extension ${dotted} is not in AUDIO_EXTENSIONS, so the scanner would never index it`);
  }

  // Taggable: the failure that motivated this gate. Silent, total, and only
  // visible as "my metadata edits do nothing".
  if (!TAGGABLE_EXTS.has(dotted)) {
    add(
      `extension ${dotted} is in neither ID3_EXTS nor VORBIS_EXTS (nor .m4a), so ` +
        `writeAudioTags returns false and the library would be permanently untaggable`,
    );
  }

  // Calibrated: rungs are codec-relative (Opus 96k ≈ mp3 160k), so a missing
  // ladder cannot fall back to another format's without encoding at the wrong
  // rate on every file.
  const ladder = LADDERS[s.id as keyof typeof LADDERS];
  if (!ladder) {
    add('has no bitrate ladder in LADDERS; rungs are codec-relative and cannot be borrowed');
  } else {
    if (ladder.steps.length === 0) add('has an empty bitrate ladder');
    else if (ladder.steps[ladder.steps.length - 1]!.upTo !== Infinity) {
      add('bitrate ladder has no Infinity catch-all, so some source bitrate falls off the end');
    }
  }

  // Encodable: a strategy that cannot produce args is not a strategy.
  try {
    const args = s.encodeArgs(128);
    if (!args.includes('-c:a')) add('encodeArgs produced no codec selection (-c:a)');
    if (!args.includes('-f')) add('encodeArgs produced no muxer selection (-f)');
  } catch (err) {
    add(`encodeArgs threw: ${(err as Error).message}`);
  }

  // Art: declared, not assumed. `maxEmbeddedPictureBytes` may legitimately be
  // null (no measured reader ceiling) but must be a deliberate value.
  if (typeof s.embedArt !== 'function') add('has no embedArt implementation');
  if (s.maxEmbeddedPictureBytes !== null && !(s.maxEmbeddedPictureBytes > 0)) {
    add('maxEmbeddedPictureBytes must be a positive byte count or null');
  }

  // Gain: `null` is a legitimate, meaningful value — mp3 and AAC have no
  // in-header gain field — so this only rejects a third state.
  if (s.writeGain !== null && typeof s.writeGain !== 'function') {
    add('writeGain must be a function or null (null means "this container has no gain field")');
  }

  // Tag carry: `null` means the encode's `-metadata` lands every field (#1289).
  if (s.postEncodeTags !== null && typeof s.postEncodeTags !== 'function') {
    add('postEncodeTags must be a function or null (null means "the encode carries every tag")');
  }

  return out;
}

function main(): void {
  const entries = Object.entries(LIBRARY_FORMATS);
  const problems = entries.flatMap(([id, s]) => problemsFor(id, s));

  const summary = entries
    .map(([id, s]) => {
      const gain = s.writeGain ? 'header gain' : 'no gain field';
      const carry = s.postEncodeTags ? ', post-encode tag carry' : '';
      const cap =
        s.maxEmbeddedPictureBytes === null ? 'no art cap' : `${s.maxEmbeddedPictureBytes}B art cap`;
      return `${id} (.${s.ext}, ${cap}, ${gain}${carry})`;
    })
    .join(', ');
  console.log(`check:library-formats: ${entries.length} library format(s) — ${summary}.`);

  if (entries.length === 0) {
    console.error(
      '\nFAIL: LIBRARY_FORMATS is empty.\n' +
        '  A gate that checks nothing prints the same clean line as one that\n' +
        '  checked every format. If the registry moved, update the import here.',
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.length} format problem(s):\n`);
    for (const p of problems) console.error(`  ✗ ${p.format}: ${p.problem}`);
    console.error(
      '\n  #1256 requires that every format an operator can choose is valid.\n' +
        '  A format that cannot be tagged or scanned is worse than one that is\n' +
        '  absent: it fails silently, on their whole library, after the\n' +
        '  irreversible pass has already run.',
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
