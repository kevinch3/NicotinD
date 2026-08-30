# Library Path Conventions

**Status:** implemented. Closes #827.

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

Scoped by **depth**, because that is where the meaning actually differs: the top level of
`musicDir` is ours to manage, everything below it is user content.

1. **At the top level of `musicDir` only**, a directory whose name starts with `.` is not library
   content.
2. **At any depth**, a *file* whose basename starts with `.` is not library content.
3. **Reserved names** (`downloads.dir`, `unsortedRoot`; defaults `.downloads`, `.unsorted`) are
   skipped at the top level **whether or not they start with a dot**, so an operator who sets
   `downloads.dir: staging` still gets `staging` skipped. Declaring them in config also gives the
   organizer, the addon env, the boot guard and these docs one constant to share.

So the skip decision for a top-level directory is: *starts with `.`* **or** *is a reserved name*.
Rule 1 covers junk nobody declared; rule 3 covers whatever this deployment actually writes to.

```
<musicDir>/
├── Artist/Album/Track.opus              ← library content
├── Artist/...And Then There Was X/      ← library content (rule 1 is root-only)
├── .downloads/                          ← acquisition staging
├── .unsorted/                           ← organizer could not place
└── .stversions/                         ← Syncthing; not ours, still correctly skipped
```

### Why root-only, and why a dot at all

Verified against the real library 2026-08-30:

| Where | Dot-directories containing audio |
| --- | --- |
| Top level | **0** |
| Below top level | **2** — `DMX/...And Then There Was X`, `Memphis La Blusera/...Etc` |

An unrestricted dot rule would silently drop those two albums; album titles opening with an
ellipsis are ordinary (`...And Justice for All`). Restricting to the top level costs nothing on a
real library and still earns its keep, because the junk that lands at a music root is dot-prefixed
and *contains audio*: `.stversions` holds prior versions of every synced track, `.Trash-1000` holds
deleted ones. Both would otherwise scan in as a duplicate library.

Note the rule does **not** catch `@eaDir` (Synology), which starts with `@`. An earlier draft
claimed it did.

### The residual risk, and why it is not silent

Rule 1 can still hit a legitimately dot-prefixed **artist** — `...And You Will Know Us by the Trail
of Dead` is a real band. That risk is accepted, but never invisible:

- `LibraryScanner` counts audio files under each skipped root directory and logs a **warning**
  naming the directory and the count when it is non-zero and the directory is not a reserved name.
- `libraryHealth` reports the same as a `skipped_paths` metric, so it surfaces in the curation
  playbook rather than only in logs.

A user whose artist vanishes sees "skipped 47 audio files under `/.../...And You Will Know Us...`"
rather than an unexplained gap. Renaming the folder is then an obvious fix.

### Why the file rule is unrestricted by depth

A dot-prefixed *filename* has no counter-example — the organizer writes `NN - Title.ext`, so a track
file never leads with a dot even when its album title does. And it fixes a live bug: macOS
AppleDouble sidecars are **currently scanned as audio**, because

```
".flac"        -> extname ""
"._Track.flac" -> extname ".flac"      ← matches AUDIO_EXTENSIONS today
```

The prod library has `/data/music/._.DS_Store` at its root, so it has had Mac contact; each sidecar
would ingest as a multi-KB "track" with unreadable tags.

## The shared predicate

One module, `packages/api/src/services/library-paths.ts`:

```ts
export const DEFAULT_RESERVED_DIRS = ['.downloads', '.unsorted'] as const;

/** The reserved top-level names for a deployment: the shipped defaults plus any
 *  relative `downloads.dir` / `unsortedRoot` the operator configured. */
export function reservedDirsFor(cfg: PathConfig): ReadonlySet<string>;

/** True when a musicDir-relative path is not library content: its FIRST
 *  segment is a dot-dir, or its basename is a dot-file. Depth matters —
 *  see "Why root-only, and why a dot at all". */
export function isReservedPath(relPath: string, reserved: ReadonlySet<string>): boolean;

/** True for a hidden file basename (`._Track.flac`, `.DS_Store`), at any depth. */
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

- **Skip every dot-directory at any depth.** Rejected on evidence — it drops
  `DMX/...And Then There Was X` and `Memphis La Blusera/...Etc` from this very library.
- **Named reserved dirs only, no dot rule.** Safe, but leaves `.stversions` / `.Trash-1000` walked,
  and those contain audio — a Syncthing user would scan in a second copy of their whole library.
- **Hardcoded `RESERVED_DIRS` constant.** Stops matching as soon as an operator overrides
  `downloads.dir`, which is the same "the default disagrees with the config" defect as #826.
- **Staging outside `musicDir`.** Costs the single mount and the atomic rename, and does not fix the
  underlying "exclusion is implicit" defect for any *other* directory.

## Known risk

Two, both narrow, both covered by the warning described under
[The residual risk](#the-residual-risk-and-why-it-is-not-silent):

- a legitimately dot-prefixed **artist** folder at the top level;
- an operator pointing `downloads.dir` at a name that later becomes a real artist folder — which
  config validation rejects at startup when the collision already exists, but cannot predict.

The risk this design *removes* is the larger one: an inferred rule silently discarding content the
user owns, which an unrestricted dot rule would have done to four songs on day one.

## Out of scope

- The Soulseek share still points at `/data/music`, so staging would be re-shared to peers. Fixing
  that is a slskd `shares` exclusion, tracked separately.
- The 25 scripts that each hand-roll `loadConfig()` — a real duplication, but not this change.
