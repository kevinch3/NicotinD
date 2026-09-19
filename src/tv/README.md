# `src/tv/` — not source

This directory holds the **F-Droid store listing for the Android TV app**
(`ar.kevinroberts.nicotind.tv`). Nothing here is compiled, imported or shipped inside any binary.

It sits in the backend's `src/` because that is the literal path fdroidserver globs
(`update.py`, `insert_localized_app_metadata`):

```
build/<applicationId>/src/<buildFlavour>/fastlane/metadata/android/<locale>/
```

`build/<applicationId>/` is the **checkout root**, and a build's `subdir` does not move that search —
verified by running the real globs against both layouts. So the path is forced: repo root, then
`src/`, then the gradle flavour name.

## Why the TV listing cannot live beside the phone's

fdroidserver also reads the checkout's root `fastlane/` tree, and **that glob has no flavour gate**.
Both of our apps build from this one repository, so the TV entry inherits the phone's listing unless
a higher-precedence tree overrides it — and `src/<flavour>/fastlane` is the only one there is
(`sorted()` puts `fastlane` before `src`, and later reads overwrite earlier ones, per file).

That precedence is also a trap: any file the phone tree has and this one lacks still shows the
phone's text under the TV entry. `check:fdroid` therefore requires this tree to be a **superset** of
the root one.

## Why a gradle flavour exists at all

`src/<flavour>/fastlane` is read only when the fdroiddata recipe's `gradle:` names that flavour —
which also makes fdroidserver run `assembleTvRelease`. So the flavour is what unlocks this directory
*and* what supplies the `.tv` application id, which used to come from an environment variable that
F-Droid's buildserver has no way to set.

The flavours carry no code, resources or dependencies. See [docs/fdroid.md](../../docs/fdroid.md).

## Editing

Don't edit changelogs by hand — `bun run release` writes them
(`packages/mobile/scripts/fdroid-changelog.ts`, from `FDROID_APPS[].fastlaneDir`). The byte caps and
the superset rule are enforced by `bun run check:fdroid`.
