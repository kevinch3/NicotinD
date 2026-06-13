# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.1.66](https://github.com/kevinch3/NicotinD/compare/v0.1.65...v0.1.66) (2026-06-13)

## [0.1.65](https://github.com/kevinch3/NicotinD/compare/v0.1.64...v0.1.65) (2026-06-13)


### Features

* **web:** bulk delete + shift-click range selection in multiselect ([a4030cc](https://github.com/kevinch3/NicotinD/commit/a4030cc44f4ed473b4953717776012f54194b3c0))

## [0.1.64](https://github.com/kevinch3/NicotinD/compare/v0.1.63...v0.1.64) (2026-06-13)


### Bug Fixes

* address E2E playground findings (deletion residue, catalog resolve, archive search) ([953cb08](https://github.com/kevinch3/NicotinD/commit/953cb08e4b4b558b458f73d2f7ef85fe826af0e8))
* **catalog:** scope album cards to matched artist, dedupe artist pills ([d0bc469](https://github.com/kevinch3/NicotinD/commit/d0bc469febec1e1ce504d0ef909c1efc8b91a120))

## [0.1.63](https://github.com/kevinch3/NicotinD/compare/v0.1.62...v0.1.63) (2026-06-13)


### Features

* **plugins:** add archive.org acquisition plugin + hunt/search surfaces ([7ae0170](https://github.com/kevinch3/NicotinD/commit/7ae0170df55c005def5a77d19c9437f0929b81c4))

## [0.1.62](https://github.com/kevinch3/NicotinD/compare/v0.1.61...v0.1.62) (2026-06-13)


### Bug Fixes

* **docker:** copy packages/e2e/package.json in both build stages ([57b4ce3](https://github.com/kevinch3/NicotinD/commit/57b4ce39aea923bbfeb1a9b6b7eee553e2e5c108))

## [0.1.61](https://github.com/kevinch3/NicotinD/compare/v0.1.60...v0.1.61) (2026-06-13)

## [0.1.60](https://github.com/kevinch3/NicotinD/compare/v0.1.59...v0.1.60) (2026-06-13)


### Bug Fixes

* **web:** keep last track loaded at end of queue ([a200235](https://github.com/kevinch3/NicotinD/commit/a200235ab03bb429af40554b023aa95fd4aa9006))
* **web:** mobile bottom chrome layering, safe-area insets, seekable edge bar ([3fc5b94](https://github.com/kevinch3/NicotinD/commit/3fc5b94bcf43286937cabbd8753c31f9279e0bae))

## [0.1.59](https://github.com/kevinch3/NicotinD/compare/v0.1.58...v0.1.59) (2026-06-05)


### Features

* **web:** fillable playlists from any track list + per-collection offline downloads ([56a31e1](https://github.com/kevinch3/NicotinD/commit/56a31e1fffa4e7b62a7426900a8886ba46c822d4))


### Bug Fixes

* **streaming:** bound remote cover fetch and cache cover responses ([e4f78e0](https://github.com/kevinch3/NicotinD/commit/e4f78e0acbfe4ef93f097b99a4dbfaa7b800d0ea))

## [0.1.58](https://github.com/kevinch3/NicotinD/compare/v0.1.57...v0.1.58) (2026-06-04)


### Features

* **web:** re-enable offline downloads for albums, playlists & genres ([7c09eb3](https://github.com/kevinch3/NicotinD/commit/7c09eb33f3aae9a4750f851fa23d5d3985e3964a))

## [0.1.57](https://github.com/kevinch3/NicotinD/compare/v0.1.56...v0.1.57) (2026-06-04)

## [0.1.56](https://github.com/kevinch3/NicotinD/compare/v0.1.55...v0.1.56) (2026-06-04)


### Bug Fixes

* **web:** prevent automatic library refreshes and add discrete lazy loading progress bar ([2493a71](https://github.com/kevinch3/NicotinD/commit/2493a714f02d5633b37fc456b2120c85e5e2631b))

## [0.1.55](https://github.com/kevinch3/NicotinD/compare/v0.1.54...v0.1.55) (2026-06-04)


### Features

* **plugins:** capability-based acquisition plugin architecture ([8367e4b](https://github.com/kevinch3/NicotinD/commit/8367e4be20d44edf439dd5cc038ea9fe77318985))


### Bug Fixes

* mobile layout, adaptive transfer polling, cover art negative cache ([bfe2110](https://github.com/kevinch3/NicotinD/commit/bfe2110990e2fe056f1791b42f141ccdd70e3f93))

## [0.1.54](https://github.com/kevinch3/NicotinD/compare/v0.1.53...v0.1.54) (2026-06-04)


### Features

* show acquire jobs in Downloads and remove Uploads tab ([3da3876](https://github.com/kevinch3/NicotinD/commit/3da38762e04a823e907439ca8285d65f46d8ea59))


### Bug Fixes

* add AcquireJob to web core type shim ([4c7d695](https://github.com/kevinch3/NicotinD/commit/4c7d695b65f6cf5c751a4bf7b68d1cbbc7e9486e))

## [0.1.53](https://github.com/kevinch3/NicotinD/compare/v0.1.52...v0.1.53) (2026-06-04)


### Bug Fixes

* parse artist/title from YouTube video title in yt-dlp ([14cd589](https://github.com/kevinch3/NicotinD/commit/14cd589ecfa35e9ab60e416cc3acb0382fcd5d61))

## [0.1.52](https://github.com/kevinch3/NicotinD/compare/v0.1.51...v0.1.52) (2026-06-04)


### Bug Fixes

* locateOnDisk handles absolute paths from yt-dlp ([ac34684](https://github.com/kevinch3/NicotinD/commit/ac346844e6b7bc13156089136da53da9c9bfe579))

## [0.1.51](https://github.com/kevinch3/NicotinD/compare/v0.1.50...v0.1.51) (2026-06-04)


### Bug Fixes

* playlist schema migration and webm audio support ([7bc8a6d](https://github.com/kevinch3/NicotinD/commit/7bc8a6db7f8d62f2e18223bcfd5755225b8c16d7))

## [0.1.50](https://github.com/kevinch3/NicotinD/compare/v0.1.49...v0.1.50) (2026-06-03)


### Features

* singles & EPs, library song search, and native playlists ([9bb3b5c](https://github.com/kevinch3/NicotinD/commit/9bb3b5c56abdb77beaa6c08bbf1678598965cbef))

## [0.1.49](https://github.com/kevinch3/NicotinD/compare/v0.1.48...v0.1.49) (2026-06-03)


### Bug Fixes

* hunter fixes ([0c6b1c3](https://github.com/kevinch3/NicotinD/commit/0c6b1c3b61049c56ed040914c7f6bd20b32bbaba))

## [0.1.48](https://github.com/kevinch3/NicotinD/compare/v0.1.47...v0.1.48) (2026-06-03)


### Features

* label downloads with canonical hunt metadata ([0b9d53c](https://github.com/kevinch3/NicotinD/commit/0b9d53c3bf6267aeb7c85df6dcec3e2b7bb356b7))
* **web:** show the actual hunt search strings while searching ([597c0c0](https://github.com/kevinch3/NicotinD/commit/597c0c077604d2110030a99d9608a1ad8e50cf0a))


### Bug Fixes

* install yt-dlp/spotdl in image and honor acquire enabled flag ([26146b5](https://github.com/kevinch3/NicotinD/commit/26146b51d59089ac658ee91cc03fe3d704648ff5))
* stop re-downloading on-disk tracks when completing an album ([908c125](https://github.com/kevinch3/NicotinD/commit/908c125c26e2df7856a685b4ab38ff4d41ff05e2))
* **web:** back button returns to the previous view ([2f3029b](https://github.com/kevinch3/NicotinD/commit/2f3029b580e94eb031470a8e75c3867c14ce3be7))
* **web:** make the seek bar respond to taps and drags ([9883a61](https://github.com/kevinch3/NicotinD/commit/9883a6143276ef485ccf4b1436baf8cfefe29e96))

## [0.1.47](https://github.com/kevinch3/NicotinD/compare/v0.1.46...v0.1.47) (2026-06-03)


### Features

* improve acquisition ([54a3c55](https://github.com/kevinch3/NicotinD/commit/54a3c553565898aa671915f100886e18a47564e1))

## [0.1.46](https://github.com/kevinch3/NicotinD/compare/v0.1.45...v0.1.46) (2026-06-02)


### Features

* theme-based fallback for coverless albums/artists ([b182c4e](https://github.com/kevinch3/NicotinD/commit/b182c4e9707f008fa6ee046611456c7b14c63fbf))

## [0.1.45](https://github.com/kevinch3/NicotinD/compare/v0.1.44...v0.1.45) (2026-06-02)


### Features

* targeted per-album artwork lookup for substantial albums ([c01ea9e](https://github.com/kevinch3/NicotinD/commit/c01ea9e72d99fe936323ed7cbc3ac3642f4260d6))

## [0.1.44](https://github.com/kevinch3/NicotinD/compare/v0.1.43...v0.1.44) (2026-06-02)


### Bug Fixes

* **hunt:** prevent duplicate albums from fallback-peer folders and restart replay ([85b1a46](https://github.com/kevinch3/NicotinD/commit/85b1a465a30a47b2065922e89e5e86963f712873))

## [0.1.43](https://github.com/kevinch3/NicotinD/compare/v0.1.42...v0.1.43) (2026-06-02)


### Performance

* backfill-artwork resolves monitored artists only by default ([c1ba818](https://github.com/kevinch3/NicotinD/commit/c1ba8182a142aaebc8c05cd9a13ab03179bf414f))

## [0.1.42](https://github.com/kevinch3/NicotinD/compare/v0.1.41...v0.1.42) (2026-06-02)


### Features

* canonical album artwork + artist thumbnails ([7cb2dbc](https://github.com/kevinch3/NicotinD/commit/7cb2dbc1b66389efac0502da37cae97805035547))

## [0.1.41](https://github.com/kevinch3/NicotinD/compare/v0.1.40...v0.1.41) (2026-06-02)


### Features

* remove navidrome ([ae45d6e](https://github.com/kevinch3/NicotinD/commit/ae45d6e7abb632d8d3911d7710db54096fd11aa4))

## [0.1.40](https://github.com/kevinch3/NicotinD/compare/v0.1.39...v0.1.40) (2026-06-02)

## [0.1.39](https://github.com/kevinch3/NicotinD/compare/v0.1.38...v0.1.39) (2026-06-02)


### Bug Fixes

* **repair:** keep unmatched tracks in canonical trim instead of deleting them ([8b81346](https://github.com/kevinch3/NicotinD/commit/8b813464ea4d47e8a16394983f804b59453e118c))

## [0.1.38](https://github.com/kevinch3/NicotinD/compare/v0.1.37...v0.1.38) (2026-06-02)


### Bug Fixes

* **hunt:** make album acquisition idempotent so one album = one folder = one card ([fb97f3c](https://github.com/kevinch3/NicotinD/commit/fb97f3c6f6b33af38edce2887cd18ce42a908be3))

## [0.1.37](https://github.com/kevinch3/NicotinD/compare/v0.1.36...v0.1.37) (2026-06-02)

## [0.1.36](https://github.com/kevinch3/NicotinD/compare/v0.1.35...v0.1.36) (2026-06-02)


### Bug Fixes

* **library:** canonicalize fragmented albums in syncer so one album = one card ([675ef32](https://github.com/kevinch3/NicotinD/commit/675ef323a45be8499496e971e59d58a5f1e1a7b8))

## [0.1.35](https://github.com/kevinch3/NicotinD/compare/v0.1.34...v0.1.35) (2026-06-01)


### Bug Fixes

* **navidrome:** group albums by artist+name to stop duplicate cards from mixed peer MBIDs ([f167a31](https://github.com/kevinch3/NicotinD/commit/f167a31c6833f5bbed79aba344f7c33a8dca403b))

## [0.1.34](https://github.com/kevinch3/NicotinD/compare/v0.1.33...v0.1.34) (2026-06-01)


### Features

* **hunt:** diacritic-insensitive matching, weak-base skew merge, fresh per-track fallback ([3adc628](https://github.com/kevinch3/NicotinD/commit/3adc628eb19b5a5287e7eaecc1f78e01a77d78bb))
* **library:** format-preference and automatic post-download deduplication ([5e6fa2d](https://github.com/kevinch3/NicotinD/commit/5e6fa2d1035187381c329b0dea009765b3dca27d))
* **service-manager:** retry Navidrome early-exit on startup ([f00480c](https://github.com/kevinch3/NicotinD/commit/f00480c94118f34c4af59077995578339ce67246))
* **web:** untracked-downloads backfill + admin surfaces for incomplete albums ([a1f00d9](https://github.com/kevinch3/NicotinD/commit/a1f00d91cb1ab147e07bb39c602fdb651274f00f))

## [0.1.33](https://github.com/kevinch3/NicotinD/compare/v0.1.32...v0.1.33) (2026-06-01)


### Bug Fixes

* **hunt:** target chosen folder manifest in album fallback to stop duplicate rips ([8e8cc3d](https://github.com/kevinch3/NicotinD/commit/8e8cc3ddf77d6a02299209357c3dfbce5c0ff148))

## [0.1.32](https://github.com/kevinch3/NicotinD/compare/v0.1.31...v0.1.32) (2026-06-01)


### Features

* **hunt:** enable skew search by default ([fda1ec8](https://github.com/kevinch3/NicotinD/commit/fda1ec89035776bae6239b83d95ad2f8a2a4b73e))

## [0.1.31](https://github.com/kevinch3/NicotinD/compare/v0.1.30...v0.1.31) (2026-06-01)


### Features

* **hunt:** add opt-in search-term skew and rework album-hunt filters ([1be31de](https://github.com/kevinch3/NicotinD/commit/1be31de7752e82087786dd00bde3dba835f12250))


### Bug Fixes

* **library:** make album deletion reliable with folder-delete + tombstone guard ([75fcadd](https://github.com/kevinch3/NicotinD/commit/75fcadd905a3eead39db0df1c8105605f71dffb8))

## [0.1.30](https://github.com/kevinch3/NicotinD/compare/v0.1.29...v0.1.30) (2026-05-31)


### Bug Fixes

* **docker:** add docker group (gid 981) to nicotind so logs socket is accessible as uid 1000 ([b09e790](https://github.com/kevinch3/NicotinD/commit/b09e790d35e982e71335e0c8df66b7f8d1aba0d1))

## [0.1.29](https://github.com/kevinch3/NicotinD/compare/v0.1.28...v0.1.29) (2026-05-31)


### Features

* **library:** phase A1b — remove FLAC/MP3 and case-variant duplicates per track ([2d0370b](https://github.com/kevinch3/NicotinD/commit/2d0370b0818569139a0a133bbb20283ef86a7386))


### Bug Fixes

* **library:** fix album deletion failing with 'could not be removed' ([ce9c335](https://github.com/kevinch3/NicotinD/commit/ce9c33595da96d832d4a8102671739cddafc8e8a))

## [0.1.28](https://github.com/kevinch3/NicotinD/compare/v0.1.27...v0.1.28) (2026-05-31)


### Features

* **library:** add Phase A0 — merge empty and 'Artist - Album' top-level folders ([ecaee01](https://github.com/kevinch3/NicotinD/commit/ecaee01ccf21f5dba180f4442a3069bce3c69f46))

## [0.1.27](https://github.com/kevinch3/NicotinD/compare/v0.1.25...v0.1.27) (2026-05-31)


### Features

* **library:** normalize-library script, Singles fix, track provenance UI ([bdc7e6d](https://github.com/kevinch3/NicotinD/commit/bdc7e6d4a19e0ed2884ca633877c764308921fc0))


### Bug Fixes

* deployment skip bump ([38db49e](https://github.com/kevinch3/NicotinD/commit/38db49e1bd7d174a7df7bfabf4ca9709679889ed))
* **docker:** run nicotind, slskd, navidrome as uid 1000 to avoid root-owned music files ([7c4ddb4](https://github.com/kevinch3/NicotinD/commit/7c4ddb4d67ca690345d50190370dc5e391f8052c))
* download indicator update ([7a5f9d4](https://github.com/kevinch3/NicotinD/commit/7a5f9d433f8c69eec4e7c33ec884deb36191076a))
* **lint:** remove unused catch bindings and import in normalize scripts ([de6a8b6](https://github.com/kevinch3/NicotinD/commit/de6a8b6c291a59ca869f4947fd7854e8f7aeab30))
* **streaming:** return 404 instead of forwarding Subsonic XML errors as images ([02657ec](https://github.com/kevinch3/NicotinD/commit/02657ec71caddc4f65e3826a1ba76184c4dbc652))

## [0.1.26](https://github.com/kevinch3/NicotinD/compare/v0.1.23...v0.1.26) (2026-05-31)


### Features

* **library:** normalize-library script, Singles fix, track provenance UI ([bdc7e6d](https://github.com/kevinch3/NicotinD/commit/bdc7e6d4a19e0ed2884ca633877c764308921fc0))
* **search:** metadata-driven search via Lidarr/MusicBrainz with album-hunt flow ([8c79a03](https://github.com/kevinch3/NicotinD/commit/8c79a03121719a8cd8b811bcf17ab99d5579d892))


### Bug Fixes

* deployment skip bump ([38db49e](https://github.com/kevinch3/NicotinD/commit/38db49e1bd7d174a7df7bfabf4ca9709679889ed))
* **docker:** run nicotind, slskd, navidrome as uid 1000 to avoid root-owned music files ([7c4ddb4](https://github.com/kevinch3/NicotinD/commit/7c4ddb4d67ca690345d50190370dc5e391f8052c))
* download indicator update ([7a5f9d4](https://github.com/kevinch3/NicotinD/commit/7a5f9d433f8c69eec4e7c33ec884deb36191076a))
* **lint:** remove unused catch bindings and import in normalize scripts ([de6a8b6](https://github.com/kevinch3/NicotinD/commit/de6a8b6c291a59ca869f4947fd7854e8f7aeab30))
* **web:** unbreak production build — missing computed import + render hunt modal ([8dd8895](https://github.com/kevinch3/NicotinD/commit/8dd8895a7fd2eb616754f0785af1a23b916f0172))

## [0.1.25](https://github.com/kevinch3/NicotinD/compare/v0.1.24...v0.1.25) (2026-05-31)

## [0.1.24](https://github.com/kevinch3/NicotinD/compare/v0.1.23...v0.1.24) (2026-05-31)


### Features

* **search:** metadata-driven search via Lidarr/MusicBrainz with album-hunt flow ([8c79a03](https://github.com/kevinch3/NicotinD/commit/8c79a03121719a8cd8b811bcf17ab99d5579d892))


### Bug Fixes

* **web:** unbreak production build — missing computed import + render hunt modal ([8dd8895](https://github.com/kevinch3/NicotinD/commit/8dd8895a7fd2eb616754f0785af1a23b916f0172))

## [0.1.23](https://github.com/kevinch3/NicotinD/compare/v0.1.22...v0.1.23) (2026-05-31)


### Features

* **player:** drag-to-expand/collapse with mobile UX hardening ([fafa3ac](https://github.com/kevinch3/NicotinD/commit/fafa3acca05b0670ea3b2ea63f1714081bddd15e))

## [0.1.22](https://github.com/kevinch3/NicotinD/compare/v0.1.21...v0.1.22) (2026-05-31)


### Features

* **library:** add minimum track-count filter to album view ([f223aa7](https://github.com/kevinch3/NicotinD/commit/f223aa75689e8f2b1adb6992b8edab434c410a1b))

## [0.1.21](https://github.com/kevinch3/NicotinD/compare/v0.1.20...v0.1.21) (2026-05-31)

## [0.1.20](https://github.com/kevinch3/NicotinD/compare/v0.1.19...v0.1.20) (2026-05-31)


### Features

* **downloads:** add auto-retry and cross-peer fallback for failed transfers ([b36710d](https://github.com/kevinch3/NicotinD/commit/b36710d323b9802269c88d59120e44542b9b6fcd))

## [0.1.19](https://github.com/kevinch3/NicotinD/compare/v0.1.18...v0.1.19) (2026-05-30)


### Bug Fixes

* **lidarr:** pass metadataProfileId when adding an artist ([4bf9144](https://github.com/kevinch3/NicotinD/commit/4bf9144b90309930ab0bdd8614a82d3967a4ebc6))

## [0.1.18](https://github.com/kevinch3/NicotinD/compare/v0.1.17...v0.1.18) (2026-05-30)


### Bug Fixes

* **deploy:** bind real music dir into Lidarr container ([7effe76](https://github.com/kevinch3/NicotinD/commit/7effe76f2352e54f70d9dd8a071572890eb5926a))

## [0.1.17](https://github.com/kevinch3/NicotinD/compare/v0.1.16...v0.1.17) (2026-05-30)


### Bug Fixes

* **auto-playlist:** track post-organize path so resolution doesn't miss ([9c461b0](https://github.com/kevinch3/NicotinD/commit/9c461b089ce67c2193597e0c55a26057a8796474))
* **lidarr:** make root folder auto-provision actually work ([af4dd4d](https://github.com/kevinch3/NicotinD/commit/af4dd4dda1b7b8e56a99673b4cbeff908de17391))

## [0.1.16](https://github.com/kevinch3/NicotinD/compare/v0.1.15...v0.1.16) (2026-05-30)


### Features

* auto-provision Lidarr root folder on startup ([dce844f](https://github.com/kevinch3/NicotinD/commit/dce844f422ec048efa71588dac7a77e2784b5b95))
* **deploy:** add Lidarr to compose stack with auto-wired API key ([84a43dd](https://github.com/kevinch3/NicotinD/commit/84a43ddf51f5316252f554e3e318fbfbd86a75a4))
* **lidarr-client:** add addRootFolder method ([b39c666](https://github.com/kevinch3/NicotinD/commit/b39c66698a2d79c0c9815d685f7ee010d09444b5))

## [0.1.15](https://github.com/kevinch3/NicotinD/compare/v0.1.14...v0.1.15) (2026-05-30)

## [0.1.14](https://github.com/kevinch3/NicotinD/compare/v0.1.13...v0.1.14) (2026-05-30)

## [0.1.13](https://github.com/kevinch3/NicotinD/compare/v0.1.12...v0.1.13) (2026-05-30)


### Bug Fixes

* **sync:** coerce null duration to 0 on album/song upsert ([dfac43c](https://github.com/kevinch3/NicotinD/commit/dfac43ce53bd5fff0addeb1b8edfe4cbe3c748ac))

## [0.1.12](https://github.com/kevinch3/NicotinD/compare/v0.1.11...v0.1.12) (2026-05-30)


### Bug Fixes

* **web:** restore discographyGroups computed and coverArtUrl type ([fcaa1ee](https://github.com/kevinch3/NicotinD/commit/fcaa1ee82f5ad75368d55c495c104f693d2e5045))

## [0.1.11](https://github.com/kevinch3/NicotinD/compare/v0.1.10...v0.1.11) (2026-05-30)

## [0.1.10](https://github.com/kevinch3/NicotinD/compare/v0.1.9...v0.1.10) (2026-05-30)


### Features

* implement the feature itself and their CI and tests ([89f8fb6](https://github.com/kevinch3/NicotinD/commit/89f8fb64403304e332a74b9291a677674dc33cfb))


### Bug Fixes

* test of library-organizer ([c418bab](https://github.com/kevinch3/NicotinD/commit/c418bab0eaa5e49809a9e5404aca29dae57737d9))
* **test:** restore node:fs after library.test to stop global mock leak ([08ac5d5](https://github.com/kevinch3/NicotinD/commit/08ac5d5db5a0c92f9ec03de7844ae8c84e55a307))

## [0.1.9](https://github.com/kevinch3/NicotinD/compare/v0.1.8...v0.1.9) (2026-05-25)


### Features

* **library:** hide synthetic Singles albums from album grid ([743d4ee](https://github.com/kevinch3/NicotinD/commit/743d4ee40f86b8a71ec85f2d1f0ab38f99c49549))

## [0.1.8](https://github.com/kevinch3/NicotinD/compare/v0.1.7...v0.1.8) (2026-05-25)


### Features

* **library:** infer + persist titles for filename-shaped tracks ([0668fea](https://github.com/kevinch3/NicotinD/commit/0668fea20d33ccc55aa90a2d430d97394fc43c23))
* **library:** strip featured-artist suffixes from artist folder names ([9335067](https://github.com/kevinch3/NicotinD/commit/93350672ddffab4815df4b64404950cdd8b91f26))
* **playlists:** one shared list with creator/modifier tracking ([a5beaf1](https://github.com/kevinch3/NicotinD/commit/a5beaf12d810121ca3b760e9ab004b28bd34feec))


### Bug Fixes

* **library:** clean filename-shaped titles on tagged files; reject phantom-dir albums ([455bab2](https://github.com/kevinch3/NicotinD/commit/455bab2bb8b8c9168d231c7d6685bb4c2c535fe1))

## [0.1.7](https://github.com/kevinch3/NicotinD/compare/v0.1.6...v0.1.7) (2026-05-14)


### Features

* **library:** canonical NicotinD library DB with hide/classify curation ([1cb27a6](https://github.com/kevinch3/NicotinD/commit/1cb27a60c2628347b7e17c5ded890e12c3fe2b56))
* **library:** organize new downloads into <Artist>/<Album>/<Track> with AcoustID enrichment ([3fa8287](https://github.com/kevinch3/NicotinD/commit/3fa8287c77a5fa75ec4417fc9c39cd9c7ead8353))

## [0.1.6](https://github.com/kevinch3/NicotinD/compare/v0.1.5...v0.1.6) (2026-05-13)


### Features

* add backfil compilation tags ([0de6391](https://github.com/kevinch3/NicotinD/commit/0de639131888b31dbd1911574f159b30a8a56354))
* **metadata:** add backfill script for existing downloads ([ab5eab9](https://github.com/kevinch3/NicotinD/commit/ab5eab96a3c85b08ac928beb02cb964c4256dace))

## [0.1.5](https://github.com/kevinch3/NicotinD/compare/v0.1.4...v0.1.5) (2026-05-13)


### Features

* **metadata:** replace MetadataFixer with lean compilation tagger ([c18f96a](https://github.com/kevinch3/NicotinD/commit/c18f96a5207490dead7c607673ee256ca9ccffb8))

## [0.1.4](https://github.com/kevinch3/NicotinD/compare/v0.1.3...v0.1.4) (2026-05-11)


### Bug Fixes

* **web:** read app version from root package.json instead of stale workspace one ([128a0d8](https://github.com/kevinch3/NicotinD/commit/128a0d88bd6cd9897820069d95efbc33093a0441))

## [0.1.3](https://github.com/kevinch3/NicotinD/compare/v0.1.2...v0.1.3) (2026-05-11)

## [0.1.2](https://github.com/kevinch3/NicotinD/compare/v0.1.1...v0.1.2) (2026-05-11)


### Bug Fixes

* **api:** return 503 when slskd is unreachable instead of 500 ([308716a](https://github.com/kevinch3/NicotinD/commit/308716a75add196f75bd781c4b2f850efb20df52))

## 0.1.1 (2026-05-11)


### Features

* add ArtistDetailComponent and /library/artists/:id route ([766834e](https://github.com/kevinch3/NicotinD/commit/766834e2a1ff8eb1f0a6f48f725715b55ea49108))
* add ConfirmDialogComponent for destructive action confirmations ([da8cd98](https://github.com/kevinch3/NicotinD/commit/da8cd98a9533e3bb831883adc57eddf73cb4bf2f))
* add entrypoint script to automatically configure slskd music directories ([425f0d2](https://github.com/kevinch3/NicotinD/commit/425f0d218c6bf63c5245201a92c2d22283763cc7))
* add GET /api/library/genres/songs route ([0d80337](https://github.com/kevinch3/NicotinD/commit/0d803374c3f1dcc3440efd72e45be0471435020c))
* add getArtist, getGenres, getSongsByGenre to ApiService ([f9335ac](https://github.com/kevinch3/NicotinD/commit/f9335ac389030314cb9e02409456af75b1061e2b))
* add offline indicator dot to TrackRowComponent ([cb8d6b9](https://github.com/kevinch3/NicotinD/commit/cb8d6b9b80e0642544e2491ba6d7a09bbcfad5c8))
* add playlist offline download toggle and per-track indicator ([e9dfcc6](https://github.com/kevinch3/NicotinD/commit/e9dfcc60a694789f2abb725c722d42af3535cb0a))
* add PlaylistAutocompleteComponent ([8faf995](https://github.com/kevinch3/NicotinD/commit/8faf9957fe338e6c27e8995a1d7de2d89adfea32))
* add Preserved (offline) section to Downloads page with storage bar ([4ea321d](https://github.com/kevinch3/NicotinD/commit/4ea321d6827a79d9fa30a90690d95b669e0e363b))
* add template extraction script ([666a67f](https://github.com/kevinch3/NicotinD/commit/666a67f22252491fe9edb5a21c2c8986a80a81e9))
* add TrackAction interface and context menu to TrackRowComponent ([33a39df](https://github.com/kevinch3/NicotinD/commit/33a39df7183f7de1a710f6200714d738c6209221))
* **admin:** replace polling log viewer with live SSE stream ([cfff402](https://github.com/kevinch3/NicotinD/commit/cfff40227b692bac37df0d85b065d696794306f5))
* **admin:** replace polling log viewer with live SSE stream ([4f5de9d](https://github.com/kevinch3/NicotinD/commit/4f5de9da78f0e2367c5436222f27d9ad5687bd96))
* **api:** add AutoPlaylistService with cleanFolderName and groupByDirectory helpers ([c7ea7a1](https://github.com/kevinch3/NicotinD/commit/c7ea7a1d9d3af072cea1e7e4930f96aec08d6d7f))
* **api:** add GET /api/users/:username/browse route with timeout handling ([e1cbf13](https://github.com/kevinch3/NicotinD/commit/e1cbf13060fb51be5bfa3192e75b8a72c3c88504))
* **api:** add ProviderRegistry.getBrowseProvider() ([240830a](https://github.com/kevinch3/NicotinD/commit/240830a51230102d5fe6dd122cd1189bc763bee1))
* **api:** GET /songs/:id/similar endpoint with multi-signal scoring ([f696494](https://github.com/kevinch3/NicotinD/commit/f6964942631f5796e0623919db084cc7fb57267d))
* **api:** implement AutoPlaylistService.processBatch with song resolution and dedup ([86ac568](https://github.com/kevinch3/NicotinD/commit/86ac568380f3994320c3590cd8c1fe2836efbfe1))
* **api:** SlskdSearchProvider implements IBrowseProvider; poll response includes canBrowse ([fcfe1ac](https://github.com/kevinch3/NicotinD/commit/fcfe1ac7bd7eb37970f30378b6eacc5e4f515ffb))
* **api:** wire AutoPlaylistService into DownloadWatcher after scan debounce ([8302df6](https://github.com/kevinch3/NicotinD/commit/8302df63b192612756952de939d42b5330875596))
* check IndexedDB before streaming in player for offline playback ([5313c00](https://github.com/kevinch3/NicotinD/commit/5313c008702117ff239d95530db29f1fea0312bf))
* **core:** add BrowseDirectory, IBrowseProvider, BrowseUnavailableError types ([70fdb84](https://github.com/kevinch3/NicotinD/commit/70fdb84cb8ab1d1a53e00dffdaecbe181e77259b))
* disable register ([f243371](https://github.com/kevinch3/NicotinD/commit/f24337108bcfac870aef895fbc2446e157e715ce))
* Download Folders — folder-grouped search results and inline user library browser ([ddb54b6](https://github.com/kevinch3/NicotinD/commit/ddb54b6933f10242706a95ac4c0c4cd4d3989eca))
* downloads — autocomplete playlist picker, album remove with confirm, song context menu ([5e28c5c](https://github.com/kevinch3/NicotinD/commit/5e28c5c63c232e3b6d784c712b15e52b554124a4))
* **downloads:** tabs, artist navigation, admin delete guard, retry polling ([c49cdc9](https://github.com/kevinch3/NicotinD/commit/c49cdc952ad98c8cebe76e672a26a4e8f56cd28f))
* enable pwa ([75bd91b](https://github.com/kevinch3/NicotinD/commit/75bd91b1c25055dd085572d6b59109a999f7c0ef))
* expose slskd capabilities in search, downloads, and settings ([5c1b251](https://github.com/kevinch3/NicotinD/commit/5c1b2517a471f67c1272e0d587379fdf43713092))
* extract inline templates to separate .html files ([2c6d32d](https://github.com/kevinch3/NicotinD/commit/2c6d32d10156b4f476c76e57d66f6e3f079fc60b))
* gate remote playback WS on toggle; auto-disable with reason on persistent failure ([6ab054d](https://github.com/kevinch3/NicotinD/commit/6ab054d5719cac068aca25c2fd02123296e72ac0))
* hide device switcher when remote playback disabled; show auto-disable reason in settings ([b669e31](https://github.com/kevinch3/NicotinD/commit/b669e318c83cf053d4b4c467a1936ab3b6427bf1))
* highlight for search term ([d69c225](https://github.com/kevinch3/NicotinD/commit/d69c22569aa3b03fb62b79294542de4ee254cf6f))
* implement bulk song deletion API and update frontend to support batch removal ([d953653](https://github.com/kevinch3/NicotinD/commit/d9536539037183acf5615656110fefcb32dad18b))
* implement fallback for `crypto.randomUUID` for device ID resolution in non-secure contexts ([c6f29cf](https://github.com/kevinch3/NicotinD/commit/c6f29cf1fb46117f12bbdb19a3db9a687f947598))
* Implement individual track download buttons with status in FolderBrowser and ref refactor folder download status management to be internal. ([947c729](https://github.com/kevinch3/NicotinD/commit/947c729f055df127712dd5d7925df9c1397a1980))
* implement shift-click range selection for downloads list ([c1af311](https://github.com/kevinch3/NicotinD/commit/c1af3117ac61788d11a65fd9d3ea5d1194b39326))
* initialize PreserveService on app start ([634172d](https://github.com/kevinch3/NicotinD/commit/634172deadce36fc4dbc491498ef1b992475b6b7))
* **layout:** logo navigates to Downloads; global search bar; offline UI ([c48f41e](https://github.com/kevinch3/NicotinD/commit/c48f41eda993bafcedbeb20a8dcf7245bec97d50))
* library — mode switcher, Artists mode, Genre mode, album/track removal, artist links ([0bcd6db](https://github.com/kevinch3/NicotinD/commit/0bcd6db98b8f20f7292af16dc272c281bb258ecb))
* library — open album from ?album= query param (artist deep-link) ([6cfa96f](https://github.com/kevinch3/NicotinD/commit/6cfa96fefc856c5017b6f77592ebcd2bc14493ea))
* library metadata reprocess and duplicate detection ([ce0dada](https://github.com/kevinch3/NicotinD/commit/ce0dadaae244fd251291e067b72d2300d0038c5e))
* **library:** add organize-library job to rename files to canonical paths ([33d40a1](https://github.com/kevinch3/NicotinD/commit/33d40a11d8e925859e6ea51a71b3b0ea874b7f54))
* **library:** migrate navidrome_id for existing downloads on startup ([eb0ff01](https://github.com/kevinch3/NicotinD/commit/eb0ff01d0cc9f959d70f3e35cefb6e5a4fdeead4))
* **permissions:** restrict song/album deletion to admin role ([295795d](https://github.com/kevinch3/NicotinD/commit/295795d49de4a116aac28d70ac7bafd50005aedf))
* play shuffled ([5db26e8](https://github.com/kevinch3/NicotinD/commit/5db26e8ef31ffbcf39cad528a0c1cae6c4588327))
* **player:** dual-audio preloading for gapless track transitions ([25cc0a7](https://github.com/kevinch3/NicotinD/commit/25cc0a7996460262411b6f0954ccac0b906e971e))
* playlists — rename modal, newest-first, always-visible search, track context menu, confirm on delete ([cac4305](https://github.com/kevinch3/NicotinD/commit/cac4305b17555df67d58abb0a1c47034cbccbe57))
* **playlists:** add personal/global visibility with owner controls ([960ea02](https://github.com/kevinch3/NicotinD/commit/960ea02e17368c6945b91fb4edaa1a75b55cc2d2))
* Refactor API routes to use Hono OpenAPI and Zod for schema definition and validation, and add mobile player design documentation. ([0b37b3c](https://github.com/kevinch3/NicotinD/commit/0b37b3c134e20a6741b35a2a11f6ea20a79f9cfa))
* remove global nav search bar — search lives on the Search page ([58b7589](https://github.com/kevinch3/NicotinD/commit/58b758976904c672ebae51bce326a9ae4d1b8903))
* replace ng test with vitest runner; add template-inliner plugin and TestBed setup ([bbf58ab](https://github.com/kevinch3/NicotinD/commit/bbf58ab0f2dae8006a640dd479cefa4efc1d8329))
* search and folders ([979ea83](https://github.com/kevinch3/NicotinD/commit/979ea83e06d86971d5a93b108a2f21a379d6f3c7))
* **search:** expand audio format support to flac, opus, m4a, aac, wav, and more ([a1f6065](https://github.com/kevinch3/NicotinD/commit/a1f606558666c4454ae1980daf3b7435e1819e99))
* **share:** add Share button to album and playlist detail views ([2723148](https://github.com/kevinch3/NicotinD/commit/272314825019f2e7b564f243b1bc82908f8146b1))
* **share:** add share route — generate and activate endpoints ([158a791](https://github.com/kevinch3/NicotinD/commit/158a7912bbe76de0dd1d8aedfa9f54e14f9502fc))
* **share:** add share_tokens table and extend JwtPayload ([7552387](https://github.com/kevinch3/NicotinD/commit/75523875bf393d936a82f037191a003c5433271a))
* **share:** add ShareSessionService ([f74621c](https://github.com/kevinch3/NicotinD/commit/f74621cc78baefe00f35a13af5d0bfe4479f698c))
* **share:** read-only guard for share JWTs in auth middleware ([4f3e45d](https://github.com/kevinch3/NicotinD/commit/4f3e45d96e6b02b45ce0cc36838731e5dfed6e5e))
* **share:** register share routes in API server ([6a653f3](https://github.com/kevinch3/NicotinD/commit/6a653f3202ee556a7a5b2806bc1d448938105ab7))
* **slskd-client:** add UsersApi with browseUser endpoint ([cffda94](https://github.com/kevinch3/NicotinD/commit/cffda94c25bd456a069a029d8ff246db1340f5b9))
* **system:** add SSE Docker log streaming endpoint ([bf7e87f](https://github.com/kevinch3/NicotinD/commit/bf7e87f16ef6098f3643ba3976c096c5497885b1))
* **tailscale:** persist auth key in secrets and auto-reconnect on startup ([596355d](https://github.com/kevinch3/NicotinD/commit/596355d5c658dff6a0fd21d03b9cf62a2eeb5362))
* **tailscale:** surface auth URL and connected state in Settings UI ([17de2ba](https://github.com/kevinch3/NicotinD/commit/17de2badc65bfa575a1575356c723be479097402))
* **theme:** add E-Ink preset with high contrast and larger base font ([c3c2060](https://github.com/kevinch3/NicotinD/commit/c3c2060199baabbdd5b861bd00422e2501f3cdb0)), closes [#000](https://github.com/kevinch3/NicotinD/issues/000)
* track consecutive WS connection failures in PlaybackWsService ([4264dc9](https://github.com/kevinch3/NicotinD/commit/4264dc9c0db8c84a404a2671368e6cb5ad3a835f))
* **web/Player:** full Media Session API integration with conditional next/prev ([3659717](https://github.com/kevinch3/NicotinD/commit/3659717b972b449e0a102b730a22281a384a3cba))
* **web/Search:** extract executeSearch, auto-search on mount, history dropdown, clickable names ([36103dc](https://github.com/kevinch3/NicotinD/commit/36103dcceb0af4b7e03b6b26b5b07684fe3b11b3))
* **web:** add 'Add to playlist' action to album and genre track lists ([d923ba2](https://github.com/kevinch3/NicotinD/commit/d923ba2179550d0f64f655a7bfefbb6df70d6673))
* **web:** add all page components ([ea0a729](https://github.com/kevinch3/NicotinD/commit/ea0a729b8ea3abc47e6ccf77fbc8a89dbf405e60))
* **web:** add autoSearch + search history to store, useNavigateAndSearch hook ([4525d86](https://github.com/kevinch3/NicotinD/commit/4525d86671df778c1a4fbe35540a87b68987f16c))
* **web:** add bitRate to Track and PreservedTrackMeta; bump IndexedDB to v2 ([7cfa173](https://github.com/kevinch3/NicotinD/commit/7cfa173f57a93d565de26a95723756984d9cd8c8))
* **web:** add browseUser API call and canBrowse to pollNetwork type ([cf3f67d](https://github.com/kevinch3/NicotinD/commit/cf3f67d82cdb002e5a9b6e951a7f4926dbc7ec20))
* **web:** add core services (auth, API, theme, setup) ([19d986b](https://github.com/kevinch3/NicotinD/commit/19d986b8d6f2a347891c7b3cb39e8840ca9dbb91))
* **web:** add CoverArt component with deterministic gradient fallback ([6f12a6e](https://github.com/kevinch3/NicotinD/commit/6f12a6e8cd70a9cf91e94a22ed09f590131f6f28))
* **web:** add CSS theme token system with 6 presets ([08b95cb](https://github.com/kevinch3/NicotinD/commit/08b95cba86c3bbbea2797c7d555f911148c4e090))
* **web:** add downloadStatus helpers with full test coverage (TDD) ([e7e9493](https://github.com/kevinch3/NicotinD/commit/e7e9493890ef80dcf4ea08cab9190dd776f1c67e))
* **web:** add folder utility functions (extract, group, tree builder) ([d41ce4b](https://github.com/kevinch3/NicotinD/commit/d41ce4bb4579da9035540f38069343ac24ad9ab1))
* **web:** add FolderBrowser component with tree nav and download-all ([6143155](https://github.com/kevinch3/NicotinD/commit/6143155dc06bb18c58259b718a7e11acf1280523))
* **web:** add global useTransferStore polling GET /api/downloads every 3s ([8820bdd](https://github.com/kevinch3/NicotinD/commit/8820bddb8f0c19680bdbea3ccf5e2b1477a58c67))
* **web:** add libraryDirty flag to transfer store on download completion ([07f6898](https://github.com/kevinch3/NicotinD/commit/07f6898f4c6ce32d3b7837db24561745806c339c))
* **web:** add player and remote playback services ([29ff4ae](https://github.com/kevinch3/NicotinD/commit/29ff4ae6f5849a54e76653ef7638c89b58b93eb2))
* **web:** add player, layout and playback UI components ([cad7b15](https://github.com/kevinch3/NicotinD/commit/cad7b15147fb951d14cb0141001b0591e8ed225d))
* **web:** add search, transfer, list-controls and preserve services ([d30d8f8](https://github.com/kevinch3/NicotinD/commit/d30d8f81c8fb1349905058e700b4aa0021a2cae8))
* **web:** add shared UI components ([4c1e4b1](https://github.com/kevinch3/NicotinD/commit/4c1e4b101574419b8118c31975ee0dd8bbac545a))
* **web:** add shared utility libs ([b45815b](https://github.com/kevinch3/NicotinD/commit/b45815b9c939baa6211bbef82b7f9a06acacbab7))
* **web:** add theme picker to Settings with system preference toggle ([8c88178](https://github.com/kevinch3/NicotinD/commit/8c881785b49e015da77e1577b1cbe529a661b689))
* **web:** add theme Zustand store with 6 presets + system preference ([468fc3a](https://github.com/kevinch3/NicotinD/commit/468fc3a7913dbd9d71179d2d505c7e90d5df78e3))
* **web:** add Tracks/Folders toggle and inline FolderBrowser to search results ([db068fd](https://github.com/kevinch3/NicotinD/commit/db068fd2e2fcdd54f5748bb487940a410953d07b))
* **web:** always show filter/sort toolbar in Library, Downloads, and Playlists ([cbd1458](https://github.com/kevinch3/NicotinD/commit/cbd1458ade6afe9bb4de83e1bc10868e391186d5))
* **web:** auto-refresh Library when a download completes ([9253385](https://github.com/kevinch3/NicotinD/commit/9253385b2d2b908001316a526634f115e8867f48))
* **web:** extract TransferEntry type to lib/transferTypes.ts for bun:test compat ([3e7ec5a](https://github.com/kevinch3/NicotinD/commit/3e7ec5a0f9898015d71543676024a2777c924ebb))
* **web:** folder download size=0 filter + live status on folder and FolderBrowser buttons ([7a03e25](https://github.com/kevinch3/NicotinD/commit/7a03e25f55c357b5800bba7f9a96874a9708d0ad))
* **web:** initialise theme store on app mount ([a5fc26a](https://github.com/kevinch3/NicotinD/commit/a5fc26a24dcc987f313f84dacb8ef1f0df7f5abb))
* **web:** inline download progress states on Search track cards ([6cc853d](https://github.com/kevinch3/NicotinD/commit/6cc853d3c94f933a66527a3cd8bb7591c6e9d61a))
* **web:** migrate hardcoded zinc classes to CSS theme variable utilities ([19827cc](https://github.com/kevinch3/NicotinD/commit/19827cceb4e9ee4a37fa323af50db24a8eaaba19))
* **web:** persist downloadedFolders to localStorage, survive reset and reload ([ed76694](https://github.com/kevinch3/NicotinD/commit/ed76694a8b2a8216805ec1db823f694f990b59fa))
* **web:** saved offline — multiselect, bulk actions, bitrate/duration/date columns ([328d9f9](https://github.com/kevinch3/NicotinD/commit/328d9f9c67cf17c53ebe1fe2237cc9c9a739411d))
* **web:** Search similar tracks — context menu, similar results section, API integration ([501c9b2](https://github.com/kevinch3/NicotinD/commit/501c9b2938b998510795f22f657515e2bf869051))
* **web:** TrackContextMenu with artist search, clickable artist names in Player/NowPlaying/Downloads ([3df12a4](https://github.com/kevinch3/NicotinD/commit/3df12a415007a402e83e70838db1272ae46c664a))
* **web:** UI/UX overhaul — 6 themes, inline download progress, CoverArt, legibility fixes ([fe864ff](https://github.com/kevinch3/NicotinD/commit/fe864ffa6dbcd864dcaf4acd267211ddfa312ffc))
* **web:** use CoverArt component in Player and TrackRow ([9910089](https://github.com/kevinch3/NicotinD/commit/99100895ef628a721638dd970934dbc3d8d2b58c))


### Bug Fixes

* **admin:** add docker CLI to image and stop log stream retry on 503 ([4b55173](https://github.com/kevinch3/NicotinD/commit/4b55173ff8d07f45b54885192aa1b25d4e8d8625))
* **admin:** move effect to field initializer and guard null token in log stream ([d275c80](https://github.com/kevinch3/NicotinD/commit/d275c80dd8b7c75d96829f1e1ea790c2d3601b09))
* **api:** align REGISTER remoteEnabled server default to opt-in (=== true) ([4a0760e](https://github.com/kevinch3/NicotinD/commit/4a0760e3c87311835f409b2b71afdb03bdddc5e7))
* **api:** flush pending playlist files on DownloadWatcher stop ([8077d35](https://github.com/kevinch3/NicotinD/commit/8077d35fa0b24da41306f9d8e4d54cca1f14452b))
* **api:** isolate library.recent-songs test from shared db.js module mock ([6067e61](https://github.com/kevinch3/NicotinD/commit/6067e61120ee56b87334914e9ba2e3ff09e5a02a))
* **api:** preserve BrowseUnavailableError through Promise.race catch wrapper ([2988870](https://github.com/kevinch3/NicotinD/commit/2988870d8efb99f869c178ffa7007880298c14c4))
* **api:** waitForScan do-while; add resolveSongId V1 comment; minor polish ([28aeffb](https://github.com/kevinch3/NicotinD/commit/28aeffba60aad030ef31a7675c0be15da13c55e2))
* auto-playlist ([37deddc](https://github.com/kevinch3/NicotinD/commit/37deddc050d05f4d864d1b61928a5ead2420465b))
* **auto-playlist:** pass expanded musicDir to AutoPlaylistService ([3172850](https://github.com/kevinch3/NicotinD/commit/317285024256b1c3e789f2a0fc9efd7588eedc58))
* **auto-playlist:** prevent basename collisions from causing duplicate covers ([b880015](https://github.com/kevinch3/NicotinD/commit/b880015dd2cb0f099b5c69c6500071ba07f043c1))
* **auto-playlist:** resolve songs via recent-album basename index ([02d49e0](https://github.com/kevinch3/NicotinD/commit/02d49e01c69c3c31cd57afc2a0dba17b6ce65ede))
* **auto-playlist:** strip Navidrome absolute path prefix when resolving song IDs ([2ab5ab8](https://github.com/kevinch3/NicotinD/commit/2ab5ab8c96712e2d5177102214f2400f92928cb7))
* browse folder timeouts ([2699faf](https://github.com/kevinch3/NicotinD/commit/2699faf852a58e82b91f8475ddf0dd0556b41401))
* build failed ([256aa02](https://github.com/kevinch3/NicotinD/commit/256aa022561c985c76e7a78a15333f3d03d9808e))
* bulk delete status ([af64cf1](https://github.com/kevinch3/NicotinD/commit/af64cf12e699003a256a676116c80c779530b0ee))
* clear cancel downloads ([11b98f8](https://github.com/kevinch3/NicotinD/commit/11b98f8b8d6ce614ac1ffc3a3fa9ea382c02b956))
* device switcher position bugs ([3f0df93](https://github.com/kevinch3/NicotinD/commit/3f0df9384f415765430afdf40a79211e1482bbef))
* docker deploy route ([c627d5e](https://github.com/kevinch3/NicotinD/commit/c627d5ee848ca986ecae431c7cdeeca0390a165f))
* **docker:** exclude nested node_modules from build context ([2b83995](https://github.com/kevinch3/NicotinD/commit/2b839958d96e2924e4aff6b423f9eeb8ffbbad7f))
* **docker:** explicit web workspace install to guarantee devDependencies ([d7fb20c](https://github.com/kevinch3/NicotinD/commit/d7fb20cffcf8529d02862ce62af0f82cff76d31b))
* **docker:** force slskd to rescan shares on every startup ([b7becba](https://github.com/kevinch3/NicotinD/commit/b7becbaaf105cd8a57f9c6dce2db09ddb28f2929))
* **docker:** support slskd 0.25.1 entrypoint layout ([e344a68](https://github.com/kevinch3/NicotinD/commit/e344a68a47ff286fe7328d009db466379d14828f))
* download auto playlist ([076a49f](https://github.com/kevinch3/NicotinD/commit/076a49f2eb944a8e94d233b9b4023f9c0df7ae8a))
* downloads — theme tokens in menu, async confirm callback, bulk delete confirmation ([3437e9e](https://github.com/kevinch3/NicotinD/commit/3437e9eeb099d1847cb978556a96ed941dd3bc66))
* **downloads:** hide transfers on cancel-all, parallelize group removal ([9a3ee48](https://github.com/kevinch3/NicotinD/commit/9a3ee4880fa4e13441f42fecb018f127c61d0a22))
* getSong extension ([6b30b68](https://github.com/kevinch3/NicotinD/commit/6b30b68a916bd32b5b0f4a7148f2af187bde5f80))
* horizontal scroll ([d473be3](https://github.com/kevinch3/NicotinD/commit/d473be37652f27feac85a114def0b66d9f7cd37d))
* library — genre track artist action, cast cleanup, artist toolbar toggle ([58b7644](https://github.com/kevinch3/NicotinD/commit/58b7644e9b33935bad4a7469c7ed4ee09dca9478))
* library empty dirs ([9f575e2](https://github.com/kevinch3/NicotinD/commit/9f575e23c1157df075eaa9ed148c71b98925e9f8))
* **library:** add basename fallback for pre-upgrade downloads without navidrome_id ([15a0636](https://github.com/kevinch3/NicotinD/commit/15a063612e295afb7f00c9081cceab7b42a11d91))
* **library:** fuzzy-find file on disk when stored path is stale ([3a45f77](https://github.com/kevinch3/NicotinD/commit/3a45f771743412e7e98c37a106461a06fb4e92b6))
* **library:** treat ghost Navidrome records as successful deletions ([68d2a8b](https://github.com/kevinch3/NicotinD/commit/68d2a8b8d360905be73cfe2f6bdb16adced19aba))
* **library:** trigger Navidrome scan on watcher startup to clear ghost records ([e975aa7](https://github.com/kevinch3/NicotinD/commit/e975aa7c1b6511bc59db572e0a49d1e8e45f9d09))
* login prunes storage ([b78abdd](https://github.com/kevinch3/NicotinD/commit/b78abdd8ba850f9065246406289849e4643ac715))
* **metadata-fixer:** elevate per-file errors to warn and log reprocess start ([60050d7](https://github.com/kevinch3/NicotinD/commit/60050d71d0e50cfa2068c91e20ab41ca2a0ce325))
* misleading statuses of services ([54fad93](https://github.com/kevinch3/NicotinD/commit/54fad93091e067d236693f7d14ab450a6cd016e8))
* move constant declaration ([0057215](https://github.com/kevinch3/NicotinD/commit/00572159c2a51fdde5885cf7d9721ab414f34927))
* navidrome admin ([7c178c1](https://github.com/kevinch3/NicotinD/commit/7c178c1b53cfb83a0232158b395e01c17b497f7b))
* **offline:** add 3s timeout to setup check; redirect to Downloads when offline ([712e11f](https://github.com/kevinch3/NicotinD/commit/712e11f9054546de46f99a7ac452314f77eaec4f))
* payer component update tests ([4707b20](https://github.com/kevinch3/NicotinD/commit/4707b201bc160a0347239aafc8dfd3183415efa7))
* persist search folder browser state in SearchService across navigation ([a8047b9](https://github.com/kevinch3/NicotinD/commit/a8047b97c7f5ca65259431e982f8eb19866f3265))
* player component test mock removal ([a36f2c2](https://github.com/kevinch3/NicotinD/commit/a36f2c20093d40d0fa8aae84976d9b5084c3e3e4))
* player fix for background attempt 1 ([50bb753](https://github.com/kevinch3/NicotinD/commit/50bb7535c9fd34597b907109980c02f426c11146))
* **player:** advance queue correctly when Android screen is locked ([2aacbbf](https://github.com/kevinch3/NicotinD/commit/2aacbbfe1ddc627783a0959c50a4df275466749a))
* **player:** move playNext() inside else branch to avoid double-advancing on repeat-one ([b13df55](https://github.com/kevinch3/NicotinD/commit/b13df55cf175b56c96f999f63ed40649bb597c53))
* **player:** prevent playback restart when preserving tracks offline ([5f7f8aa](https://github.com/kevinch3/NicotinD/commit/5f7f8aa514420770c54cd9f97d176202d08ffa58))
* **player:** resume playback after PWA returns from background on Android ([46ce4d5](https://github.com/kevinch3/NicotinD/commit/46ce4d5c5841d0f18f368a9c8ea8ca2c49a2fe5f))
* playlists — theme tokens in modal, dynamic confirm label, always-visible grid search ([d3a03d7](https://github.com/kevinch3/NicotinD/commit/d3a03d720d3180171845a054f2afc61e960755d3))
* prepend directory path to bare filenames from slskd browse API ([ba38073](https://github.com/kevinch3/NicotinD/commit/ba38073074e1495516f1e3b62127ab527ef66e7c))
* **pwa:** persist player queue and restore state on app restart ([adacca3](https://github.com/kevinch3/NicotinD/commit/adacca36fbd58ad14252bbc821e07202cb8272a1))
* **pwa:** write full snapshot on pagehide to close state-loss race ([3f44af9](https://github.com/kevinch3/NicotinD/commit/3f44af93c9355281b5b4e38bf09a2c9363862206))
* **remote-playback:** WebSocket stability, health endpoint, cleaner UI ([0433f3d](https://github.com/kevinch3/NicotinD/commit/0433f3da8fab1d0bf69a44bce95e4d81522196a0))
* remove dependency from test ([93b2307](https://github.com/kevinch3/NicotinD/commit/93b23077cc1fc8baecc3f3261947ad964f95c8a8))
* remove unused dbModule import in downloads.test.ts ([18b339b](https://github.com/kevinch3/NicotinD/commit/18b339b91a45b6f94e6a2820240d6ae833c90a06))
* replace bun image ([62a0984](https://github.com/kevinch3/NicotinD/commit/62a098454933ac4588e79d31a56697f6ed4ebebb))
* reset full failure state in clearPersistentFailure and disconnect ([45d4450](https://github.com/kevinch3/NicotinD/commit/45d445055115c70e2d21fe4533269c762ff3ab5c))
* search error handling and logs ([bba8e26](https://github.com/kevinch3/NicotinD/commit/bba8e26ab1fdfa52e50b439541070d02a37f62c6))
* **security:** shell injection, open CORS, unbounded Set, and type safety ([9f7d2b0](https://github.com/kevinch3/NicotinD/commit/9f7d2b09f2362d514780e51fcf9b35b2ff1b806c))
* serveStatic path relative ([d9b9c88](https://github.com/kevinch3/NicotinD/commit/d9b9c889bcd34f1f4c46b24d135c6fce794e4059))
* **share:** add ON DELETE CASCADE to share_tokens.created_by ([60264c3](https://github.com/kevinch3/NicotinD/commit/60264c391442369393b679dc1190bf0b5f31fcb0))
* **share:** fold static classes into [class] binding on share buttons ([84294c1](https://github.com/kevinch3/NicotinD/commit/84294c10ab54ce035ffa317413d44de48b6aa046))
* **share:** interceptor header passthrough, stable audio ref, readonly signals ([46a1d11](https://github.com/kevinch3/NicotinD/commit/46a1d1102fd700632a6b3b79d351789318a30df8))
* **share:** test isolation cleanup and remove non-null assertion ([115b4d7](https://github.com/kevinch3/NicotinD/commit/115b4d7094150a449fd35f5b379175fb25e4ece9))
* **slskd-client:** handle slskd 0.25 shares API response format ([545c528](https://github.com/kevinch3/NicotinD/commit/545c5287ee7abd6b30ebfe3fb65031a2673d70fb))
* **slskd:** retry browse on 5xx to mitigate flaky peer connections ([3cc1f01](https://github.com/kevinch3/NicotinD/commit/3cc1f01eea25bc9d66b113bab21085f1adf3af57))
* **slskd:** retry download enqueue on 5xx peer connection failures ([07bf41c](https://github.com/kevinch3/NicotinD/commit/07bf41ca2bf19b34cc2916c393ff810bf0d4228c))
* start transfer polling from layout shell so active downloads and progress are visible ([6d20323](https://github.com/kevinch3/NicotinD/commit/6d203236fc80e3d6917caf52e5d643bde764aaca))
* stuck queued ([f843ec1](https://github.com/kevinch3/NicotinD/commit/f843ec1aed67fb933e5d0cbeb193d0562c377276))
* **system:** drain findProc stderr pipe and make SSE write handler synchronous ([141d0c2](https://github.com/kevinch3/NicotinD/commit/141d0c2c2c2e95d3d2a7e0f4741f2e35a7ae5e63))
* **system:** handle missing docker CLI in log stream endpoint ([0e0b362](https://github.com/kevinch3/NicotinD/commit/0e0b362eef8a3d43410094bdea51b645bdd92fb0))
* **system:** validate service name allowlist in log stream endpoint ([3fe3d11](https://github.com/kevinch3/NicotinD/commit/3fe3d11c310bad2b6579c50d5e98ee9ad5fce202))
* **tailscale:** runtime type guard on AuthURL and resume polling after disconnect ([04ef4b4](https://github.com/kevinch3/NicotinD/commit/04ef4b4aad646999979950ad9de8b1d8c8d2cec6))
* **tailscale:** single service instance, safe secrets write, clear key on disconnect ([eff8d52](https://github.com/kevinch3/NicotinD/commit/eff8d52c9372d62a003459d3c7ad79cf0a703e85))
* test for now-playing ([f93fdee](https://github.com/kevinch3/NicotinD/commit/f93fdee860f73c3f55182d1f4b6aa5e5df29ffb0))
* theme contrast dark ([3607832](https://github.com/kevinch3/NicotinD/commit/36078325eb0096877a45082c0dbf270e9e31388c))
* unsubscribe router.events on LayoutComponent destroy with takeUntilDestroyed ([a6044eb](https://github.com/kevinch3/NicotinD/commit/a6044eb6eb9c4ba541b23ccedd1563985d23b321))
* use HostListener for Escape key in ConfirmDialogComponent ([339fd1c](https://github.com/kevinch3/NicotinD/commit/339fd1cbc240b043fd4a859eeabfd2b9972977b4))
* use theme tokens in TrackRow context menu dropdown ([a430cfc](https://github.com/kevinch3/NicotinD/commit/a430cfcb42a3fea26e15e03da3e6d2e87895cbcf))
* **watcher:** use full scan and leaf-only path for slskd downloads ([9859bb5](https://github.com/kevinch3/NicotinD/commit/9859bb5eac61dc208f386ad02e0d2631e2a8f84f))
* **web/api:** type getDownloads() return as SlskdUserTransferGroup[] ([512d7ee](https://github.com/kevinch3/NicotinD/commit/512d7ee00f17a77e526b53519e88398b50c41ee1))
* **web/downloadStatus:** guard empty-files edge case + add disabled assertions in tests ([552f40b](https://github.com/kevinch3/NicotinD/commit/552f40b39ac4cfa11b1936d00d63af50b51fcb30))
* **web/FolderBrowser:** add optimistic Queued state to Download all button ([49cc63f](https://github.com/kevinch3/NicotinD/commit/49cc63f0aef139867ba51929b4cc291501927394))
* **web/search:** filter size=0 stubs + wire track download buttons to live transfer status ([8ac095a](https://github.com/kevinch3/NicotinD/commit/8ac095abd80c862f6a4c2cb8f91065f1cf751a5b))
* **web:** add type guard on downloadedFolders localStorage hydration ([1c6acc8](https://github.com/kevinch3/NicotinD/commit/1c6acc8d20e033fdfcf0545a0e69c04ad7dc773b))
* **web:** align REGISTER remoteEnabled default with store — opt-out by default ([454cb2c](https://github.com/kevinch3/NicotinD/commit/454cb2cc47df3d21cf353e3f9ccd5d2016e263d5))
* **web:** complete theme var migration for playlists text elements ([0ccef6a](https://github.com/kevinch3/NicotinD/commit/0ccef6a790ab815647297267004896e81dc9a192))
* **web:** filter size=0 stubs from folderFiles before getFolderDownloadLabel ([2ab8b91](https://github.com/kevinch3/NicotinD/commit/2ab8b91c8ee8f07d99a55fed50956c88b91b4d1e))
* **web:** guard onPause handler against store-driven and inactive-device pauses ([dfc2095](https://github.com/kevinch3/NicotinD/commit/dfc2095c26ad58167969f531b0ed1896aae383ae))
* **web:** guard remote playback provider against disabled-device auto-play ([9fd051a](https://github.com/kevinch3/NicotinD/commit/9fd051a12a08dc055ee9dac2d6aade418926862a))
* **web:** keep playlist picker open when library add-to-playlist fails ([979cf19](https://github.com/kevinch3/NicotinD/commit/979cf19652bdcd2eeb6eed44cc9fc44cc653fcb0))
* **web:** legibility — raise min text size to 12px, fix page padding and player height ([9b4c48a](https://github.com/kevinch3/NicotinD/commit/9b4c48ab543eaa36232e9d8e84b2240b8d17b89a))
* **web:** normalise path separators in isPathEffectivelyQueued ([dd138ee](https://github.com/kevinch3/NicotinD/commit/dd138ee93374bfaa1e0d294a913ffad068d5b1f7))
* **web:** offline tab — error handling in removeOfflineTracks and picker dismiss ([f1cadbd](https://github.com/kevinch3/NicotinD/commit/f1cadbd1e2703f66511cb6413588f9a69ec4d728))
* **web:** render TrackContextMenu via portal to escape NowPlaying stacking context ([2d0f1d4](https://github.com/kevinch3/NicotinD/commit/2d0f1d4f4f6417bb91f381f11d9c92d63331baa2))
* **web:** strict null check and hoist remoteEnabled read in RemotePlaybackProvider ([abb0ae5](https://github.com/kevinch3/NicotinD/commit/abb0ae59302959451e6792ac587f66332dde0602))
* **web:** suppress TS6 baseUrl deprecation warning in Docker build ([fdf9eb9](https://github.com/kevinch3/NicotinD/commit/fdf9eb9f799d6df5a38bd02daf8481ab5d8e66da))
* **web:** sync isPlaying store flag from audio play/pause events ([fa10429](https://github.com/kevinch3/NicotinD/commit/fa10429449e6c63eb5da409302a6e8f7f3b88f1a))
* **web:** theme-aware buttons/cards in library+playlists; fix offline select-all under active filter ([395c0ee](https://github.com/kevinch3/NicotinD/commit/395c0eee8b00b938b122d677486c86145fb94634))
* **web:** use folder-level optimistic state to prevent cross-folder download bleeding ([7737ce8](https://github.com/kevinch3/NicotinD/commit/7737ce808ae9201c22f44875735ccadc5988e75e))
* **web:** use prefix matching for isFolderQueued — covers sub-folder navigation ([2383531](https://github.com/kevinch3/NicotinD/commit/23835314c37d4432f91f512fa7d4b608ce9bf268))
* **web:** use removeItem instead of clear() in remote-playback test ([d99b9ee](https://github.com/kevinch3/NicotinD/commit/d99b9ee7c0cdd6efbe18330ecbc4e3d6a2194f55))
* **web:** use theme vars for track-row and playlist title colors ([397f1cd](https://github.com/kevinch3/NicotinD/commit/397f1cd0de180236c723d7a50412392f4af28942))
