# Library Path Conventions (design spec)

**Status:** proposed — not yet implemented. Refs #827.

## The problem

"This directory under `musicDir` is not library content" is an **implicit** property today. It is
asserted nowhere, enforced by nothing, and independently re-derived by every module that walks the
tree. Two live consequences:

1. **#827.** The slskd addon downloads into `/data/music` (`--downloads=/data/music`). The
   lossless→Opus hook lives in `LibraryOrganizer.placeFile()`, so a file that never reaches the
   organizer is never standardized — and a file downloaded *into* the scanned tree never does.
   Measured on prod 2026-08-30: 922 unorganized rows / 27.5 GB, 824 of them FLAC, every album
   present twice.
2. **A latent twin.** `library-organizer.ts:161` defaults `unsortedRoot` to the **relative**
   `'Unsorted'`, resolved under `musicDir`. Production only escapes it because `index.ts:234`
   overrides it to `${dataDir}/unsorted`, with the comment *"Park unsortable files OUTSIDE musicDir
   so Navidrome doesn't scan them."* A self-hoster who doesn't override gets unsortable files
   scanned straight back into their library.

`LibraryScanner.walk()` (`library-scanner.ts:800-818`) descends into every directory
unconditionally — there is no exclusion mechanism to extend.

## Non-goal

Moving acquisition staging *outside* `musicDir`. That is what the `unsortedRoot` override did, and
it solves the problem only for the one walker you happened to think about. It also costs the two
things worth keeping:

- **One volume mount.** A self-hoster configures one path, not two. Adding mounts is the failure
  mode this design exists to avoid.
- **Same-filesystem ingest.** `moveFileAcrossDevices` exists in the organizer because a cross-device
  move is a copy-plus-delete. Staging inside `musicDir` makes every ingest an atomic `rename()`
  instead of a 40 MB copy per track.

## The rule

Two layers, deliberately. The general rule keeps foreign junk out; the named constants give our own
writers and guards something canonical to point at.

1. **Any directory whose basename starts with `.` is not library content.** One rule, matching the
   Plex / Jellyfin / Navidrome convention. Sweeps up `@eaDir`-style NAS junk, `.Trash-1000`,
   `.stfolder` and our own dirs alike.
2. **Reserved names are declared, not discovered.** `RESERVED_DIRS` names the ones NicotinD itself
   writes into, so the organizer, the addons, the boot guard and the docs share one constant rather
   than a string literal each.

```
<musicDir>/
├── Artist/Album/Track.opus     ← library content
├── .downloads/                 ← acquisition staging (addons write here)
└── .unsorted/                  ← files the organizer could not place
```

`.` is a directory-level rule only. A dot-prefixed *file* is already ignored by the
`AUDIO_EXTENSIONS` check and needs no new handling.

## The shared predicate

One module, `packages/api/src/services/library-paths.ts`:

```ts
export const RESERVED_DIRS = ['.downloads', '.unsorted'] as const;

/** True when this path segment is staging/junk rather than library content. */
export function isReservedSegment(name: string): boolean;

/** True when any segment of a musicDir-relative path is reserved. */
export function isReservedPath(relPath: string): boolean;

/** Resolve the acquisition staging dir for a musicDir. */
export function downloadsDirFor(musicDir: string): string;
```

`isReservedSegment` is the single place the dot rule lives. Everything else composes it.

### Enforced at two depths, not one

`LibraryScanner.walk()` skipping reserved dirs is necessary but not sufficient — `scanPaths()`
takes caller-supplied relative paths and would happily ingest `.downloads/foo.flac` if a caller
passed it. **`scanPaths()` must filter through `isReservedPath()` too.** A walk-only guard is one
forgotten call site away from the bug it was written to prevent.

## Call sites

Thirteen modules resolve paths under `musicDir` and need the predicate. Six others
(`backup.ts`, `migration-backup.ts`, `cover-cache-prune.ts`, `artwork-store.ts`,
`album-reconcile.ts`, `album-dedupe.ts`) walk `dataDir` or receive an album dir from a caller and
are out of scope.

| Module | Change |
| --- | --- |
| `library-scanner.ts` | `walk()` skips reserved dirs; `scanPaths()` filters reserved paths |
| `library-organizer.ts` | `unsortedRoot` default becomes `.unsorted`; never places *into* a reserved dir |
| `library-import.service.ts` | skip reserved dirs when importing a server folder |
| `library-disk-audit.ts` | exclude from the audit denominator (a gate must not count staging as pollution) |
| `import-scan.ts`, `untracked-backfill.ts`, `library-deletion.ts` | skip reserved |
| `scripts/reorganize-library.ts` | add to the existing `excludeDirs` set |
| `scripts/normalize-library.ts`, `repair-album-dupes.ts`, `repair-album-folders.ts`, `repair-singles.ts`, `repair-pollution.ts` | skip reserved |

## The gate

`check:library-walkers`. Without it this convention rots — the codebase already demonstrates the
failure mode twice (#826's four disagreeing defaults, #827 itself).

AST-walk `packages/api/src`, find modules that call `readdir`/`readdirSync`/`opendirSync` **and**
reference `musicDir`, and fail when the module does not import from `library-paths.ts`. Per the
project's own rule that a gate asserts its own denominator: print the module count examined, fail
on anything it cannot classify, and check the allowlist both ways so a stale exemption is an error.

## Configuration

```yaml
downloads:
  # Acquisition staging. Relative → resolved under musicDir (same filesystem, atomic
  # renames, one volume mount). Absolute → a separate disk, for people who want one.
  dir: .downloads      # NICOTIND_DOWNLOADS_DIR
```

Same relative-or-absolute shape `unsortedRoot` already uses (`library-organizer.ts:159-162`), so
this is an existing idiom rather than a new one.

**A relative `downloads.dir` MUST start with `.`** — config validation rejects it otherwise. A
relative `downloads/` would resolve under `musicDir` and be walked like any other folder, which is
#827 again wearing a different name. An absolute path is unconstrained: it is outside `musicDir`, so
the walkers never see it. This is why the dot rule and the named constants are both load-bearing —
rule 1 covers a user who overrides the name, `RESERVED_DIRS` covers the default we ship.

**Boot guard.** `findInsecureDefaults` warns when a registered addon's downloads dir resolves
inside `musicDir` but is *not* a reserved path — the exact #827 shape, currently silent.

## Migration

Existing installs are the hard part: prod already has 27.5 GB of staging-shaped content sitting in
the library proper, and it is indistinguishable by path from real music that merely lives in a flat
folder.

1. **Ship the convention.** New downloads land in `.downloads`; the leak stops.
2. **Do not auto-move anything.** Of prod's 922 unorganized rows, only 173 are provable duplicates
   of an organized copy — the other 749 are real content a user would be furious to find moved into
   a hidden folder. Automatic classification here is a data-loss risk, per the
   `project_pollution_delete_safety_705` finding that junk metadata ≠ junk audio.
3. **Report, then let a human choose.** Extend `libraryHealth` with an `unorganized` dimension
   (depth-2 path + no `acquisitions` row) and a worst-first worklist, so the existing curation
   playbook surfaces it. Cleanup stays a curator action.

`config/default.yml` is not in the Docker image (#824), so `downloads.dir` must have a working
schema default and must be settable by env alone.

## Testing

- `library-paths.test.ts` — the dot rule, nested reserved segments, absolute-vs-relative resolution,
  and that a legitimately-named `Artist/.../Album` is untouched.
- `library-scanner.test.ts` — a file under `.downloads` is not scanned by `scanFull`, **and** is
  refused by `scanPaths` when passed explicitly.
- `library-organizer.test.ts` — the organizer moves *out of* `.downloads` into `Artist/Album`, and
  never places into a reserved dir.
- `check:library-walkers` self-test: a fixture module that walks `musicDir` without the import must
  fail the gate.

## Rejected alternatives

- **Named reserved dirs only, no dot rule.** Fully predictable, nothing a user owns can vanish —
  but leaves NAS junk dirs walked, and every new staging dir is another special case.
- **Dot rule only, no named constants.** Then `.downloads` is a string literal in the organizer, the
  addon env, the boot guard and the docs — the drift #826 was made of.
- **Staging outside `musicDir`.** Costs the single mount and the atomic rename, and does not fix the
  underlying "exclusion is implicit" defect for any *other* directory.

## Known risk

A user with a legitimately dot-prefixed music folder loses it from the library silently. Mitigation:
`LibraryScanner` logs skipped reserved dirs at debug, and the `unorganized` health dimension counts
audio files found under reserved paths so a surprising number is visible rather than invisible.

## Out of scope

- The Soulseek share still points at `/data/music`, so staging would be re-shared to peers. Fixing
  that is a slskd `shares` exclusion, tracked separately.
- The 25 scripts that each hand-roll `loadConfig()` — a real duplication, but not this change.
