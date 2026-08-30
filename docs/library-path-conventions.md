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
   and `reorganize-library.ts:208` both override it to `${dataDir}/unsorted` — the latter with the
   comment *"Park unsortable files OUTSIDE musicDir so Navidrome doesn't scan them."* A self-hoster
   who doesn't override gets unsortable files scanned straight back into their library.

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

Reserved directories are **named, never inferred** — and the names come from config, so the
staging dir a deployment actually uses is the one the walkers actually skip.

1. **A directory is skipped only when its name is in the reserved set**, matched at the top level
   of `musicDir` only. The set is derived from config (`downloads.dir` and `unsortedRoot` when
   relative), defaulting to `.downloads` and `.unsorted`.
2. **A file is skipped when its basename starts with `.`** — the ordinary hidden-file convention.

```
<musicDir>/
├── Artist/Album/Track.opus     ← library content
├── .downloads/                 ← acquisition staging (addons write here)
└── .unsorted/                  ← files the organizer could not place
```

The leading dot on the shipped defaults is a **convention** (keeps them out of the way in a file
manager), not the mechanism. Nothing is excluded *because* it starts with a dot.

### Why not "skip every dot-directory"

That was the first draft of this spec, and it is wrong. Verified against the prod library
2026-08-30 — **two real albums already present would have silently disappeared**:

```
Memphis La Blusera/...Etc/07 - Arrepentido.mp3
DMX/...And Then There Was X/07 - Party Up.mp3
```

Album titles opening with an ellipsis are ordinary (`...And Justice for All`), and restricting the
rule to the top level does not save it either — `...And You Will Know Us by the Trail of Dead` is
an *artist*. A music library is precisely the domain where a leading dot carries no meaning.

The justification offered for the general rule was also false on inspection: it does **not** sweep
up `@eaDir` (Synology), which starts with `@`, not `.`.

### Why the file rule is safe where the directory rule is not

A dot-prefixed *filename* has no such counter-example: the organizer writes `NN - Title.ext`, so a
track file never leads with a dot even when its album title does. And the rule fixes a live
problem — macOS AppleDouble sidecars (`._Track.flac`) are **currently scanned as audio**, because
`extname('._Track.flac')` is `'.flac'`:

```
".flac"        -> extname ""
"._Track.flac" -> extname ".flac"      ← matches AUDIO_EXTENSIONS today
```

The prod library has `/data/music/._.DS_Store` at its root, so it has had Mac contact; the sidecars
are a matter of when, not whether. Each would ingest as a multi-KB "track" with unreadable tags.

## The shared predicate

One module, `packages/api/src/services/library-paths.ts`:

```ts
export const DEFAULT_RESERVED_DIRS = ['.downloads', '.unsorted'] as const;

/** The reserved top-level names for a deployment: the shipped defaults plus any
 *  relative `downloads.dir` / `unsortedRoot` the operator configured. */
export function reservedDirsFor(cfg: PathConfig): ReadonlySet<string>;

/** True when a musicDir-relative path is staging rather than library content:
 *  its FIRST segment is reserved, or any segment is a dot-prefixed file. */
export function isReservedPath(relPath: string, reserved: ReadonlySet<string>): boolean;

/** True for a hidden file basename (`._Track.flac`, `.DS_Store`). Directory
 *  names are NOT judged by their leading dot — see "Why not skip every
 *  dot-directory". */
export function isHiddenFile(basename: string): boolean;

/** Resolve the acquisition staging dir for a musicDir. */
export function downloadsDirFor(musicDir: string, cfg: PathConfig): string;
```

Deriving the set from config is what makes the exclusion honest: an operator who sets
`downloads.dir: staging` gets `staging` reserved, so the dir that is written to is the dir that is
skipped. A hardcoded constant would silently stop matching the moment anyone overrode it.

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

A relative value needs no naming constraint, because `reservedDirsFor()` reads the same config the
organizer writes to — set `downloads.dir: staging` and `staging` becomes reserved. An absolute path
is unconstrained too: it sits outside `musicDir`, so the walkers never see it.

The one rule config must enforce: a relative `downloads.dir` may not be nested
(`a/b`) and may not collide with an existing top-level artist folder. Both are startup errors, not
warnings — a staging dir that shadows an artist would hide that artist's whole discography.

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

- `library-paths.test.ts` — reserved-name matching at top level only; `isHiddenFile` on
  `._Track.flac` / `.DS_Store`; absolute-vs-relative resolution; `reservedDirsFor` picking up a
  configured override. **Regression cases from the real library:** `Memphis La Blusera/...Etc/` and
  `DMX/...And Then There Was X/` must scan normally, and an artist named
  `...And You Will Know Us by the Trail of Dead` must not be skipped.
- `library-scanner.test.ts` — a file under `.downloads` is not scanned by `scanFull`, **and** is
  refused by `scanPaths` when passed explicitly.
- `library-organizer.test.ts` — the organizer moves *out of* `.downloads` into `Artist/Album`, and
  never places into a reserved dir.
- `check:library-walkers` self-test: a fixture module that walks `musicDir` without the import must
  fail the gate.

## Rejected alternatives

- **Skip every dot-directory.** Rejected on evidence — it deletes real albums from this very
  library. See the section above.
- **Hardcoded `RESERVED_DIRS` constant.** Stops matching as soon as an operator overrides
  `downloads.dir`, which is the same "the default disagrees with the config" defect as #826.
- **Staging outside `musicDir`.** Costs the single mount and the atomic rename, and does not fix the
  underlying "exclusion is implicit" defect for any *other* directory.

## Known risk

An operator points `downloads.dir` at a name that later becomes a real artist folder, or ships music
in a file whose name starts with a dot. Both are narrow, and both are made visible rather than
silent: `LibraryScanner` logs every skipped path at debug, and the `unorganized` health dimension
counts audio files sitting under reserved paths, so a surprising number shows up in the health
report instead of vanishing.

The risk this design *removes* is the larger one — an inferred rule silently discarding content the
user owns, which the rejected dot-directory rule would have done to four songs on day one.

## Out of scope

- The Soulseek share still points at `/data/music`, so staging would be re-shared to peers. Fixing
  that is a slskd `shares` exclusion, tracked separately.
- The 25 scripts that each hand-roll `loadConfig()` — a real duplication, but not this change.
