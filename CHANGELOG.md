# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.5.52](https://github.com/kevinch3/NicotinD/compare/v0.5.51...v0.5.52) (2026-08-31)

### Bug Fixes

* **audit:** corroborate watermark_album so a domain-shaped real title is not junk ([9d21ee5](https://github.com/kevinch3/NicotinD/commit/9d21ee5ebd430347e9111291a161ec53e55054cd)), references [#705](https://github.com/kevinch3/NicotinD/issues/705)
* **scanner:** honour the per-track ARTIST tag, pinning ownership to the album ([782c5e3](https://github.com/kevinch3/NicotinD/commit/782c5e30bec32cfe13adaf323820a4a7e7e70f2c)), references [#760](https://github.com/kevinch3/NicotinD/issues/760) [#817](https://github.com/kevinch3/NicotinD/issues/817)
* **web:** give app-password-field a block-display host ([41e2954](https://github.com/kevinch3/NicotinD/commit/41e2954d3bd445a9ed548fc398bc45a8b50b100d)), closes [#832](https://github.com/kevinch3/NicotinD/issues/832)
* **web:** use the real app icon for the login brand mark ([1b5e491](https://github.com/kevinch3/NicotinD/commit/1b5e4910a19bd7f36dd90f6a8cfdd355c40e9a31))
## [0.5.51](https://github.com/kevinch3/NicotinD/compare/v0.5.50...v0.5.51) (2026-08-31)

### Bug Fixes

* **library:** one canonical audio-extension set; make the share filter actually match ([#846](https://github.com/kevinch3/NicotinD/issues/846)) ([ca91e23](https://github.com/kevinch3/NicotinD/commit/ca91e23df2cb96db21b6d8ed57b4d2105548c593)), closes [#845](https://github.com/kevinch3/NicotinD/issues/845) [#843](https://github.com/kevinch3/NicotinD/issues/843), references [#7](https://github.com/kevinch3/NicotinD/issues/7)
## [0.5.50](https://github.com/kevinch3/NicotinD/compare/v0.5.49...v0.5.50) (2026-08-31)

### Bug Fixes

* **transcode:** hide the encode temp file, and stop sharing staging to peers ([#844](https://github.com/kevinch3/NicotinD/issues/844)) ([d389774](https://github.com/kevinch3/NicotinD/commit/d3897745a1d86000b94e81a845b7035c1b811634)), closes [#841](https://github.com/kevinch3/NicotinD/issues/841) [#843](https://github.com/kevinch3/NicotinD/issues/843)
## [0.5.49](https://github.com/kevinch3/NicotinD/compare/v0.5.48...v0.5.49) (2026-08-31)

### Bug Fixes

* **scripts:** reorganize-library previews before it writes ([#840](https://github.com/kevinch3/NicotinD/issues/840)) ([#842](https://github.com/kevinch3/NicotinD/issues/842)) ([286b22e](https://github.com/kevinch3/NicotinD/commit/286b22ebe5479274816002aa651dd85d2d24c63a)), references [#838](https://github.com/kevinch3/NicotinD/issues/838)
## [0.5.48](https://github.com/kevinch3/NicotinD/compare/v0.5.47...v0.5.48) (2026-08-30)

### Bug Fixes

* **compose:** point slskd staging at the reserved .downloads path ([#827](https://github.com/kevinch3/NicotinD/issues/827)) ([#839](https://github.com/kevinch3/NicotinD/issues/839)) ([52b717b](https://github.com/kevinch3/NicotinD/commit/52b717b0a7619f1f1787da43dc10cd2f9fd6ee14))
## [0.5.47](https://github.com/kevinch3/NicotinD/compare/v0.5.46...v0.5.47) (2026-08-30)

### Features

* **library:** reserved-path convention — staging lives inside musicDir, invisibly ([#838](https://github.com/kevinch3/NicotinD/issues/838)) ([7f3f63c](https://github.com/kevinch3/NicotinD/commit/7f3f63cd3373d8d5d6695f0183fae609a7d11af9)), references [#827](https://github.com/kevinch3/NicotinD/issues/827) [#827](https://github.com/kevinch3/NicotinD/issues/827) [#827](https://github.com/kevinch3/NicotinD/issues/827) [#827](https://github.com/kevinch3/NicotinD/issues/827) [#827](https://github.com/kevinch3/NicotinD/issues/827) [#827](https://github.com/kevinch3/NicotinD/issues/827) [#824](https://github.com/kevinch3/NicotinD/issues/824)
## [0.5.46](https://github.com/kevinch3/NicotinD/compare/v0.5.45...v0.5.46) (2026-08-30)

### Features

* **auth:** admin toggle for public signup, default closed ([#833](https://github.com/kevinch3/NicotinD/issues/833)) ([19532af](https://github.com/kevinch3/NicotinD/commit/19532af5ed7f31cb3c29def8530ac805a2dd634e)), references [#824](https://github.com/kevinch3/NicotinD/issues/824) [#824](https://github.com/kevinch3/NicotinD/issues/824)
## [0.5.45](https://github.com/kevinch3/NicotinD/compare/v0.5.44...v0.5.45) (2026-08-30)

### Bug Fixes

* **downloads:** resolve transcodeLossless once instead of four disagreeing defaults ([#828](https://github.com/kevinch3/NicotinD/issues/828)) ([e0c51ab](https://github.com/kevinch3/NicotinD/commit/e0c51abb85683f3c5ebd85015a93d0199d861802))
## [0.5.44](https://github.com/kevinch3/NicotinD/compare/v0.5.43...v0.5.44) (2026-08-30)

### Bug Fixes

* **auth:** give the registration kill-switch an env lever ([#824](https://github.com/kevinch3/NicotinD/issues/824)) ([#825](https://github.com/kevinch3/NicotinD/issues/825)) ([fdcc29b](https://github.com/kevinch3/NicotinD/commit/fdcc29b62deb2ab04dfea41c769a4004b9289421)), references [#235](https://github.com/kevinch3/NicotinD/issues/235) [#454](https://github.com/kevinch3/NicotinD/issues/454)
## [0.5.43](https://github.com/kevinch3/NicotinD/compare/v0.5.42...v0.5.43) (2026-08-30)

### Features

* **web:** taste breakers shelf + colored vibe tiles on the home page ([#821](https://github.com/kevinch3/NicotinD/issues/821)) ([2a34222](https://github.com/kevinch3/NicotinD/commit/2a342224b55a4b08e716d87ad722b0cb220e4780))
## [0.5.42](https://github.com/kevinch3/NicotinD/compare/v0.5.41...v0.5.42) (2026-08-30)

### Bug Fixes

* **player:** hold a seek past the loaded region, collapse skip bursts ([#816](https://github.com/kevinch3/NicotinD/issues/816)) ([4e8720b](https://github.com/kevinch3/NicotinD/commit/4e8720bea5fa2ff2461e1db9174f70947f65a4d3))
## [0.5.41](https://github.com/kevinch3/NicotinD/compare/v0.5.40...v0.5.41) (2026-08-29)

### Bug Fixes

* **addons:** decouple file ingest from the poller tick ([#809](https://github.com/kevinch3/NicotinD/issues/809)) ([#815](https://github.com/kevinch3/NicotinD/issues/815)) ([5a61d2c](https://github.com/kevinch3/NicotinD/commit/5a61d2c0717e72e9b8fd14bead77796b195ec42e))
## [0.5.40](https://github.com/kevinch3/NicotinD/compare/v0.5.39...v0.5.40) (2026-08-29)

### Bug Fixes

* **review:** approve-all / discard-all are one bulk request with a live queue ([#808](https://github.com/kevinch3/NicotinD/issues/808)) ([#814](https://github.com/kevinch3/NicotinD/issues/814)) ([65b9b55](https://github.com/kevinch3/NicotinD/commit/65b9b5512bd77b2754c1b51c87f960f08f365351)), references [#708](https://github.com/kevinch3/NicotinD/issues/708)
## [0.5.39](https://github.com/kevinch3/NicotinD/compare/v0.5.38...v0.5.39) (2026-08-29)

### Bug Fixes

* **downloads:** a cancelled partial's tracks are discardable by the canceller ([#810](https://github.com/kevinch3/NicotinD/issues/810)) ([#813](https://github.com/kevinch3/NicotinD/issues/813)) ([9753696](https://github.com/kevinch3/NicotinD/commit/975369683127901c7cd0ce82cc9e2a0fd1845665))
## [0.5.38](https://github.com/kevinch3/NicotinD/compare/v0.5.37...v0.5.38) (2026-08-29)

### Bug Fixes

* **downloads:** byte progress on addon cards + reactive, idempotent cancel ([#805](https://github.com/kevinch3/NicotinD/issues/805), [#806](https://github.com/kevinch3/NicotinD/issues/806)) ([#812](https://github.com/kevinch3/NicotinD/issues/812)) ([b211b66](https://github.com/kevinch3/NicotinD/commit/b211b669d562777a8c2cb1ee4c64ae25a3b80324))
## [0.5.37](https://github.com/kevinch3/NicotinD/compare/v0.5.35...v0.5.37) (2026-08-29)

### Features

* **polls:** seek bar on the playing preview ([#804](https://github.com/kevinch3/NicotinD/issues/804)) ([2092fd5](https://github.com/kevinch3/NicotinD/commit/2092fd5487c2690dd312488e21bde0593779fa1a)), references [#803](https://github.com/kevinch3/NicotinD/issues/803)

### Bug Fixes

* **processing:** disabled tick still clears quarantine so 'Processing' cannot strand ([#807](https://github.com/kevinch3/NicotinD/issues/807)) ([#811](https://github.com/kevinch3/NicotinD/issues/811)) ([c719d89](https://github.com/kevinch3/NicotinD/commit/c719d89ee1917cd595f8a75effc2877bdebf6fd3))
## [0.5.36](https://github.com/kevinch3/NicotinD/compare/v0.5.35...v0.5.36) (2026-08-29)

### Features

* **polls:** seek bar on the playing preview ([#804](https://github.com/kevinch3/NicotinD/issues/804)) ([2092fd5](https://github.com/kevinch3/NicotinD/commit/2092fd5487c2690dd312488e21bde0593779fa1a)), references [#803](https://github.com/kevinch3/NicotinD/issues/803)
## [0.5.35](https://github.com/kevinch3/NicotinD/compare/v0.5.34...v0.5.35) (2026-08-29)

### Features

* **polls:** 1–5 star ratings with graded export and eval ([#802](https://github.com/kevinch3/NicotinD/issues/802)) ([4aaac60](https://github.com/kevinch3/NicotinD/commit/4aaac605887c904f8857eccd4707bccb353ae5b7)), references [#800](https://github.com/kevinch3/NicotinD/issues/800)
## [0.5.34](https://github.com/kevinch3/NicotinD/compare/v0.5.33...v0.5.34) (2026-08-29)

### Features

* **polls:** optional ratings with skip, and the premise restated on every step ([#798](https://github.com/kevinch3/NicotinD/issues/798), [#799](https://github.com/kevinch3/NicotinD/issues/799)) ([#801](https://github.com/kevinch3/NicotinD/issues/801)) ([730b810](https://github.com/kevinch3/NicotinD/commit/730b8105a21d89279cac983d3c61c90dcab3f349))
## [0.5.33](https://github.com/kevinch3/NicotinD/compare/v0.5.32...v0.5.33) (2026-08-29)

### Bug Fixes

* **mcp:** make a genre curation durable, and refuse an entity before it lands ([#762](https://github.com/kevinch3/NicotinD/issues/762), [#771](https://github.com/kevinch3/NicotinD/issues/771), [#787](https://github.com/kevinch3/NicotinD/issues/787)) ([#796](https://github.com/kevinch3/NicotinD/issues/796)) ([b93f147](https://github.com/kevinch3/NicotinD/commit/b93f1478bf352d9be3945dcbcba853ea9a19227e)), references [#773](https://github.com/kevinch3/NicotinD/issues/773)
## [0.5.32](https://github.com/kevinch3/NicotinD/compare/v0.5.31...v0.5.32) (2026-08-29)

### Bug Fixes

* **library:** run the title cleaner over the existing library, and teach it remaster labels ([#775](https://github.com/kevinch3/NicotinD/issues/775)) ([#794](https://github.com/kevinch3/NicotinD/issues/794)) ([da8187e](https://github.com/kevinch3/NicotinD/commit/da8187edcd12301f4682c99ab2a6c1f7892c4d63)), references [#722](https://github.com/kevinch3/NicotinD/issues/722) [#722](https://github.com/kevinch3/NicotinD/issues/722) [#776](https://github.com/kevinch3/NicotinD/issues/776)
## [0.5.31](https://github.com/kevinch3/NicotinD/compare/v0.5.30...v0.5.31) (2026-08-29)

### Bug Fixes

* **library:** verify a retag landed, and refresh an album after a single-song delete ([#774](https://github.com/kevinch3/NicotinD/issues/774), [#776](https://github.com/kevinch3/NicotinD/issues/776)) ([#793](https://github.com/kevinch3/NicotinD/issues/793)) ([123338e](https://github.com/kevinch3/NicotinD/commit/123338e45c170ffcef379205ae4393ba02201291))
## [0.5.30](https://github.com/kevinch3/NicotinD/compare/v0.5.29...v0.5.30) (2026-08-28)

### Bug Fixes

* **library:** read the genre tag back, and name the right dedupe identity ([#789](https://github.com/kevinch3/NicotinD/issues/789), [#791](https://github.com/kevinch3/NicotinD/issues/791)) ([#792](https://github.com/kevinch3/NicotinD/issues/792)) ([bf093ff](https://github.com/kevinch3/NicotinD/commit/bf093ffbbc49244dfd47e0131144cac57972ab1f)), references [#790](https://github.com/kevinch3/NicotinD/issues/790)
## [0.5.29](https://github.com/kevinch3/NicotinD/compare/v0.5.28...v0.5.29) (2026-08-28)

### Features

* **mcp:** make the curator surface say what it means ([#777](https://github.com/kevinch3/NicotinD/issues/777), [#778](https://github.com/kevinch3/NicotinD/issues/778), [#779](https://github.com/kevinch3/NicotinD/issues/779), [#780](https://github.com/kevinch3/NicotinD/issues/780)) ([#785](https://github.com/kevinch3/NicotinD/issues/785)) I ([c62bc3c](https://github.com/kevinch3/NicotinD/commit/c62bc3c8fe49e04b10e4b2f312687f0e4b48fbc4)), references [#757](https://github.com/kevinch3/NicotinD/issues/757) [#549](https://github.com/kevinch3/NicotinD/issues/549) [#781](https://github.com/kevinch3/NicotinD/issues/781) [#683](https://github.com/kevinch3/NicotinD/issues/683) [#784](https://github.com/kevinch3/NicotinD/issues/784)
## [0.5.28](https://github.com/kevinch3/NicotinD/compare/v0.5.27...v0.5.28) (2026-08-28)

### Bug Fixes

* **plugins:** a blank optional config field no longer defeats its default ([#782](https://github.com/kevinch3/NicotinD/issues/782)) ([01af4d7](https://github.com/kevinch3/NicotinD/commit/01af4d7539cbf24124846719bdfc03c2b9b08870)), closes [#765](https://github.com/kevinch3/NicotinD/issues/765) [14/#16](https://github.com/kevinch3/NicotinD/issues/16) [#781](https://github.com/kevinch3/NicotinD/issues/781), references [#774](https://github.com/kevinch3/NicotinD/issues/774) [#775](https://github.com/kevinch3/NicotinD/issues/775) [#776](https://github.com/kevinch3/NicotinD/issues/776) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#17](https://github.com/kevinch3/NicotinD/issues/17) [#17](https://github.com/kevinch3/NicotinD/issues/17)
## [0.5.27](https://github.com/kevinch3/NicotinD/compare/v0.5.26...v0.5.27) (2026-08-27)

### Bug Fixes

* **library:** give the genre set the mirror's durability contract ([#773](https://github.com/kevinch3/NicotinD/issues/773)) ([c081d8c](https://github.com/kevinch3/NicotinD/commit/c081d8c39eca8414c27039159648af79365dfae0))
## [0.5.26](https://github.com/kevinch3/NicotinD/compare/v0.5.25...v0.5.26) (2026-08-27)

### Bug Fixes

* **library:** make the genre listing match the same set the count does ([#772](https://github.com/kevinch3/NicotinD/issues/772)) ([0ffddb2](https://github.com/kevinch3/NicotinD/commit/0ffddb23aab5c4768d742c5b90d8d4276adf29f9)), closes [#769](https://github.com/kevinch3/NicotinD/issues/769), references [#770](https://github.com/kevinch3/NicotinD/issues/770) [#771](https://github.com/kevinch3/NicotinD/issues/771) [#770](https://github.com/kevinch3/NicotinD/issues/770) [#770](https://github.com/kevinch3/NicotinD/issues/770) [#771](https://github.com/kevinch3/NicotinD/issues/771)
## [0.5.25](https://github.com/kevinch3/NicotinD/compare/v0.5.24...v0.5.25) (2026-08-27)

### Bug Fixes

* **library:** make retags land on opus, and MCP see origin and rare genres ([#765](https://github.com/kevinch3/NicotinD/issues/765)) ([86cd0e7](https://github.com/kevinch3/NicotinD/commit/86cd0e73501dd4ac2352b6ba4f68e298a9b5c8a9)), closes [#758](https://github.com/kevinch3/NicotinD/issues/758) [#759](https://github.com/kevinch3/NicotinD/issues/759) [#760](https://github.com/kevinch3/NicotinD/issues/760) [#761](https://github.com/kevinch3/NicotinD/issues/761), references [#760](https://github.com/kevinch3/NicotinD/issues/760) [#758](https://github.com/kevinch3/NicotinD/issues/758) [#759](https://github.com/kevinch3/NicotinD/issues/759) [#761](https://github.com/kevinch3/NicotinD/issues/761) [#757](https://github.com/kevinch3/NicotinD/issues/757) [#757](https://github.com/kevinch3/NicotinD/issues/757)
## [0.5.24](https://github.com/kevinch3/NicotinD/compare/v0.5.23...v0.5.24) (2026-08-27)

### Bug Fixes

* **acquire:** make the job state vocabulary say what is happening ([#763](https://github.com/kevinch3/NicotinD/issues/763)) ([fbfaa35](https://github.com/kevinch3/NicotinD/commit/fbfaa353e4284575c957e1b4f36669f205e64948)), closes [#667](https://github.com/kevinch3/NicotinD/issues/667) [#710](https://github.com/kevinch3/NicotinD/issues/710) [#711](https://github.com/kevinch3/NicotinD/issues/711) [#714](https://github.com/kevinch3/NicotinD/issues/714) [#749](https://github.com/kevinch3/NicotinD/issues/749), references [#711](https://github.com/kevinch3/NicotinD/issues/711) [#714](https://github.com/kevinch3/NicotinD/issues/714) [#667](https://github.com/kevinch3/NicotinD/issues/667) [#710](https://github.com/kevinch3/NicotinD/issues/710) [#710](https://github.com/kevinch3/NicotinD/issues/710) [#749](https://github.com/kevinch3/NicotinD/issues/749) [#714](https://github.com/kevinch3/NicotinD/issues/714)
## [0.5.23](https://github.com/kevinch3/NicotinD/compare/v0.5.22...v0.5.23) (2026-08-27)

### Bug Fixes

* **web:** stop showing a permanently-empty Advanced card to web admins ([#756](https://github.com/kevinch3/NicotinD/issues/756)) ([c813b56](https://github.com/kevinch3/NicotinD/commit/c813b56f263d9145ba1cd1ca13dec919d060ffe6)), closes [#754](https://github.com/kevinch3/NicotinD/issues/754)
## [0.5.22](https://github.com/kevinch3/NicotinD/compare/v0.5.21...v0.5.22) (2026-08-26)
## [0.5.21](https://github.com/kevinch3/NicotinD/compare/v0.5.20...v0.5.21) (2026-08-26)

### Bug Fixes

* **acquire:** make one album mean one download on the manual lane ([#748](https://github.com/kevinch3/NicotinD/issues/748)) ([#753](https://github.com/kevinch3/NicotinD/issues/753)) ([28524eb](https://github.com/kevinch3/NicotinD/commit/28524eb1198db46174882f788650da943f64109b))
* **acquire:** report the release's tracklist as the denominator ([#752](https://github.com/kevinch3/NicotinD/issues/752)) ([3fefaad](https://github.com/kevinch3/NicotinD/commit/3fefaad8dfde02fe23295fe91b1cda17cecc392b)), references [#745](https://github.com/kevinch3/NicotinD/issues/745)
* **acquire:** stop failing a job for a 404 core caused itself ([#744](https://github.com/kevinch3/NicotinD/issues/744)) ([#750](https://github.com/kevinch3/NicotinD/issues/750)) ([88cf7eb](https://github.com/kevinch3/NicotinD/commit/88cf7eb05e5ba9d10f5a88cb8d4edd3c7ee8cbb1))
## [0.5.20](https://github.com/kevinch3/NicotinD/compare/v0.5.19...v0.5.20) (2026-08-26)
## [0.5.19](https://github.com/kevinch3/NicotinD/compare/v0.5.18...v0.5.19) (2026-08-26)

### Features

* **api:** MCP complete_album — curator-approved only-missing-tracks hunt ([#742](https://github.com/kevinch3/NicotinD/issues/742)) ([6bd385e](https://github.com/kevinch3/NicotinD/commit/6bd385eadf534ee7b30c14f60e6d09fb4d565161)), closes [#732](https://github.com/kevinch3/NicotinD/issues/732) [#733](https://github.com/kevinch3/NicotinD/issues/733) [#735](https://github.com/kevinch3/NicotinD/issues/735), references [#732](https://github.com/kevinch3/NicotinD/issues/732) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#735](https://github.com/kevinch3/NicotinD/issues/735)
## [0.5.18](https://github.com/kevinch3/NicotinD/compare/v0.5.17...v0.5.18) (2026-08-26)

### Features

* **api:** MCP album curation writes + album-route audit trail ([#741](https://github.com/kevinch3/NicotinD/issues/741)) ([373d3f0](https://github.com/kevinch3/NicotinD/commit/373d3f0ab3d8047bd837e65123197dbf3d5a864f)), closes [#732](https://github.com/kevinch3/NicotinD/issues/732) [#733](https://github.com/kevinch3/NicotinD/issues/733), references [#732](https://github.com/kevinch3/NicotinD/issues/732) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#735](https://github.com/kevinch3/NicotinD/issues/735)
## [0.5.17](https://github.com/kevinch3/NicotinD/compare/v0.5.16...v0.5.17) (2026-08-26)

### Features

* **api:** MCP get_library_health + resolve_review_flag ([#751](https://github.com/kevinch3/NicotinD/issues/751)) ([3557e4e](https://github.com/kevinch3/NicotinD/commit/3557e4eee797d1e499648dba22d3b800e348fab5)), closes [#732](https://github.com/kevinch3/NicotinD/issues/732), references [#732](https://github.com/kevinch3/NicotinD/issues/732) [#734](https://github.com/kevinch3/NicotinD/issues/734) [#734](https://github.com/kevinch3/NicotinD/issues/734)
## [0.5.16](https://github.com/kevinch3/NicotinD/compare/v0.5.15...v0.5.16) (2026-08-26)

### Features

* **api:** library health report ([#739](https://github.com/kevinch3/NicotinD/issues/739)) ([f87ed8c](https://github.com/kevinch3/NicotinD/commit/f87ed8c233c59749b0441b390cafbc5dda3ec290)), closes [#732](https://github.com/kevinch3/NicotinD/issues/732), references [#732](https://github.com/kevinch3/NicotinD/issues/732) [#734](https://github.com/kevinch3/NicotinD/issues/734)

### Bug Fixes

* **web:** arm the pull-to-refresh touch blocker before the browser can claim the pan ([#731](https://github.com/kevinch3/NicotinD/issues/731)) ([#738](https://github.com/kevinch3/NicotinD/issues/738)) ([0246ad8](https://github.com/kevinch3/NicotinD/commit/0246ad83e848e71a79eab66178cec1876a4bbfc8))
## [0.5.15](https://github.com/kevinch3/NicotinD/compare/v0.5.14...v0.5.15) (2026-08-26)

### Bug Fixes

* **acquire:** ingest files stranded when the poll cursor moves past their job ([#729](https://github.com/kevinch3/NicotinD/issues/729)) ([9e9ce31](https://github.com/kevinch3/NicotinD/commit/9e9ce3116a30b73c16464c861080db24672be827))
## [0.5.14](https://github.com/kevinch3/NicotinD/compare/v0.5.13...v0.5.14) (2026-08-26)

### Features

* **mcp:** curator tools to look up and fix song metadata (YouTube pollution) ([#728](https://github.com/kevinch3/NicotinD/issues/728)) ([095ad41](https://github.com/kevinch3/NicotinD/commit/095ad4197c38a7e582da4a5a49ae90712a79cab9)), closes [#722](https://github.com/kevinch3/NicotinD/issues/722), references [#722](https://github.com/kevinch3/NicotinD/issues/722) [#722](https://github.com/kevinch3/NicotinD/issues/722) [#722](https://github.com/kevinch3/NicotinD/issues/722) [#722](https://github.com/kevinch3/NicotinD/issues/722) [#722](https://github.com/kevinch3/NicotinD/issues/722)
## [0.5.13](https://github.com/kevinch3/NicotinD/compare/v0.5.12...v0.5.13) (2026-08-26)

### Bug Fixes

* prevent truncated preserved blobs from poisoning playback recovery ([#721](https://github.com/kevinch3/NicotinD/issues/721)) ([ac6e628](https://github.com/kevinch3/NicotinD/commit/ac6e6284b1a406996859eabf19815c5ab89f5b0b))
## [0.5.12](https://github.com/kevinch3/NicotinD/compare/v0.5.11...v0.5.12) (2026-08-25)

### Bug Fixes

* **library:** fold accents instead of deleting them, across every matcher ([#720](https://github.com/kevinch3/NicotinD/issues/720)) ([b00d02d](https://github.com/kevinch3/NicotinD/commit/b00d02d6d55141e433bead47170b6af46062d505)), closes [#706](https://github.com/kevinch3/NicotinD/issues/706) [#707](https://github.com/kevinch3/NicotinD/issues/707) [#662](https://github.com/kevinch3/NicotinD/issues/662) [#719](https://github.com/kevinch3/NicotinD/issues/719), references [#706](https://github.com/kevinch3/NicotinD/issues/706) [#719](https://github.com/kevinch3/NicotinD/issues/719) [#662](https://github.com/kevinch3/NicotinD/issues/662) [#707](https://github.com/kevinch3/NicotinD/issues/707)
## [0.5.11](https://github.com/kevinch3/NicotinD/compare/v0.5.10...v0.5.11) (2026-08-25)

### Bug Fixes

* **web:** pause job polling while the tab is hidden ([#718](https://github.com/kevinch3/NicotinD/issues/718)) ([af98bbc](https://github.com/kevinch3/NicotinD/commit/af98bbc0e3722c5de00a195ad2c67ba0905b22f3)), references [#5](https://github.com/kevinch3/NicotinD/issues/5)
## [0.5.10](https://github.com/kevinch3/NicotinD/compare/v0.5.9...v0.5.10) (2026-08-25)

### Bug Fixes

* **review:** approving a held download lands the album now, not next tick ([#708](https://github.com/kevinch3/NicotinD/issues/708)) ([#709](https://github.com/kevinch3/NicotinD/issues/709)) ([2bfb4c8](https://github.com/kevinch3/NicotinD/commit/2bfb4c8c77f4b5f381b63e958473e88839e58509))
## [0.5.9](https://github.com/kevinch3/NicotinD/compare/v0.5.8...v0.5.9) (2026-08-25)

### Bug Fixes

* **library:** repair-pollution can no longer delete real music ([#705](https://github.com/kevinch3/NicotinD/issues/705)) ([#716](https://github.com/kevinch3/NicotinD/issues/716)) ([f497340](https://github.com/kevinch3/NicotinD/commit/f497340073542f6912bf29869799aaf97aa813c8)), references [#715](https://github.com/kevinch3/NicotinD/issues/715)
## [0.5.8](https://github.com/kevinch3/NicotinD/compare/v0.5.7...v0.5.8) (2026-08-25)

### Bug Fixes

* **e2e:** wait for the library scan, so specs stop racing each other ([#655](https://github.com/kevinch3/NicotinD/issues/655)) ([#713](https://github.com/kevinch3/NicotinD/issues/713)) ([6b0ffbf](https://github.com/kevinch3/NicotinD/commit/6b0ffbf0239eb3ee6fef42056fdf30d63a19e82b)), references [#712](https://github.com/kevinch3/NicotinD/issues/712) [#616](https://github.com/kevinch3/NicotinD/issues/616)
## [0.5.7](https://github.com/kevinch3/NicotinD/compare/v0.5.6...v0.5.7) (2026-08-25)

### Bug Fixes

* **library:** show a partly-landed album, marked, instead of hiding it ([#693](https://github.com/kevinch3/NicotinD/issues/693)) ([#704](https://github.com/kevinch3/NicotinD/issues/704)) ([b85b394](https://github.com/kevinch3/NicotinD/commit/b85b3949e12b4c475f367e549fc056cb5541072e)), references [#687](https://github.com/kevinch3/NicotinD/issues/687) [#687](https://github.com/kevinch3/NicotinD/issues/687)
## [0.5.6](https://github.com/kevinch3/NicotinD/compare/v0.5.5...v0.5.6) (2026-08-25)

### Bug Fixes

* **artwork:** give albums a cover automatically, and a way to fix the backlog ([#694](https://github.com/kevinch3/NicotinD/issues/694)) ([#703](https://github.com/kevinch3/NicotinD/issues/703)) ([26f4d55](https://github.com/kevinch3/NicotinD/commit/26f4d556f2c13fe47acfa67bfbe5e3e05f3a4a2f))
* **metadata:** fill missing track numbers from the canonical tracklist ([#694](https://github.com/kevinch3/NicotinD/issues/694)) ([#702](https://github.com/kevinch3/NicotinD/issues/702)) ([f4b2484](https://github.com/kevinch3/NicotinD/commit/f4b248454b0156a4da317c40b8d7d4fd183a540b)), references [#662](https://github.com/kevinch3/NicotinD/issues/662)
## [0.5.5](https://github.com/kevinch3/NicotinD/compare/v0.5.4...v0.5.5) (2026-08-25)

### Bug Fixes

* **genre:** a junk genre is not a resolved genre ([#694](https://github.com/kevinch3/NicotinD/issues/694)) ([#701](https://github.com/kevinch3/NicotinD/issues/701)) ([7479b7a](https://github.com/kevinch3/NicotinD/commit/7479b7a77fb2280b9e0afec35a4476e9bac26a86)), references [#583](https://github.com/kevinch3/NicotinD/issues/583) [#687](https://github.com/kevinch3/NicotinD/issues/687)
## [0.5.4](https://github.com/kevinch3/NicotinD/compare/v0.5.3...v0.5.4) (2026-08-25)

### Bug Fixes

* **processing:** make landing-gate eligibility explicit ([#691](https://github.com/kevinch3/NicotinD/issues/691)) ([#700](https://github.com/kevinch3/NicotinD/issues/700)) ([1dadb38](https://github.com/kevinch3/NicotinD/commit/1dadb38c5895adba3dafb5e4703f770a14b27de6)), references [#687](https://github.com/kevinch3/NicotinD/issues/687) [#687](https://github.com/kevinch3/NicotinD/issues/687) [#687](https://github.com/kevinch3/NicotinD/issues/687)
## [0.5.3](https://github.com/kevinch3/NicotinD/compare/v0.5.2...v0.5.3) (2026-08-25)

### Bug Fixes

* **processing:** a confident negative settles a landing gate ([#696](https://github.com/kevinch3/NicotinD/issues/696)) ([b4373cb](https://github.com/kevinch3/NicotinD/commit/b4373cb80eff88d4d4cc4c87a434506df6a4e3b2)), closes [#689](https://github.com/kevinch3/NicotinD/issues/689) [#690](https://github.com/kevinch3/NicotinD/issues/690), references [#689](https://github.com/kevinch3/NicotinD/issues/689) [#690](https://github.com/kevinch3/NicotinD/issues/690) [#687](https://github.com/kevinch3/NicotinD/issues/687) [#687](https://github.com/kevinch3/NicotinD/issues/687) [#689](https://github.com/kevinch3/NicotinD/issues/689) [#697](https://github.com/kevinch3/NicotinD/issues/697) [#697](https://github.com/kevinch3/NicotinD/issues/697)
## [0.5.2](https://github.com/kevinch3/NicotinD/compare/v0.5.1...v0.5.2) (2026-08-25)

### Bug Fixes

* **discography:** count only landed songs as owned ([#692](https://github.com/kevinch3/NicotinD/issues/692)) ([#698](https://github.com/kevinch3/NicotinD/issues/698)) ([85e504f](https://github.com/kevinch3/NicotinD/commit/85e504fd74a2ae94154ce13ff1b1383b9c745099)), references [#687](https://github.com/kevinch3/NicotinD/issues/687) [#687](https://github.com/kevinch3/NicotinD/issues/687)
## [0.5.1](https://github.com/kevinch3/NicotinD/compare/v0.5.0...v0.5.1) (2026-08-24)

### Features

* **curation:** a durable "needs a human decision" flag ([#699](https://github.com/kevinch3/NicotinD/issues/699)) ([7371c8c](https://github.com/kevinch3/NicotinD/commit/7371c8c3d49b460fd95c4ac0774dccce890cb241)), closes [#682](https://github.com/kevinch3/NicotinD/issues/682)
## [0.5.0](https://github.com/kevinch3/NicotinD/compare/v0.4.12...v0.5.0) (2026-08-24)

### ⚠ BREAKING CHANGES

* GET /api/library/songs/:id/licence-suggestion and POST
  /api/library/songs/:id/licence are removed, the set_song_licence MCP tool is
  gone, `licence` no longer appears on the Album or Song DTOs, and the
  ?licence= library filter is ignored.

### Features

* roll back the licence feature ([#697](https://github.com/kevinch3/NicotinD/issues/697)) ([262b8d9](https://github.com/kevinch3/NicotinD/commit/262b8d9b49a4de9e744f0c2ff4aa1611fd277f67)), closes [#683](https://github.com/kevinch3/NicotinD/issues/683), references [#683](https://github.com/kevinch3/NicotinD/issues/683) [#329](https://github.com/kevinch3/NicotinD/issues/329) [#329](https://github.com/kevinch3/NicotinD/issues/329)
## [0.4.12](https://github.com/kevinch3/NicotinD/compare/v0.4.11...v0.4.12) (2026-08-24)

### Features

* **library:** catch structural DJ-set corruption at ingest ([#695](https://github.com/kevinch3/NicotinD/issues/695)) ([b45d37a](https://github.com/kevinch3/NicotinD/commit/b45d37ab53bcc7e6850ca4a68dbd2c4eed078668)), closes [#679](https://github.com/kevinch3/NicotinD/issues/679)
* **web:** make the track-info genre chips an editor ([#688](https://github.com/kevinch3/NicotinD/issues/688)) ([4d1a77c](https://github.com/kevinch3/NicotinD/commit/4d1a77cbaa42bc6134f4933bc6c6b2e3e5abb7e6)), closes [#684](https://github.com/kevinch3/NicotinD/issues/684)
## [0.4.11](https://github.com/kevinch3/NicotinD/compare/v0.4.10...v0.4.11) (2026-08-24)

### Features

* **mcp-agent:** write genre, batch merges, and audit the song-genre route ([#686](https://github.com/kevinch3/NicotinD/issues/686)) ([f946bce](https://github.com/kevinch3/NicotinD/commit/f946bce8f0c8882e0f9bb76d275719834d6649d2)), closes [#677](https://github.com/kevinch3/NicotinD/issues/677) [#680](https://github.com/kevinch3/NicotinD/issues/680) [#681](https://github.com/kevinch3/NicotinD/issues/681), references [#677](https://github.com/kevinch3/NicotinD/issues/677) [#232](https://github.com/kevinch3/NicotinD/issues/232) [#339](https://github.com/kevinch3/NicotinD/issues/339) [#680](https://github.com/kevinch3/NicotinD/issues/680) [#681](https://github.com/kevinch3/NicotinD/issues/681)
## [0.4.10](https://github.com/kevinch3/NicotinD/compare/v0.4.9...v0.4.10) (2026-08-24)

### Features

* **mcp-agent:** list recent songs with pagination + missing-genre filter ([#685](https://github.com/kevinch3/NicotinD/issues/685)) ([318a846](https://github.com/kevinch3/NicotinD/commit/318a846c310e980d267c11709a467aa562b8c725)), closes [#676](https://github.com/kevinch3/NicotinD/issues/676) [#678](https://github.com/kevinch3/NicotinD/issues/678)
## [0.4.9](https://github.com/kevinch3/NicotinD/compare/v0.4.8...v0.4.9) (2026-08-24)

### Bug Fixes

* **downloads:** return the raw-lane grab's addon job receipt so one click is one card ([#675](https://github.com/kevinch3/NicotinD/issues/675)) ([f837b52](https://github.com/kevinch3/NicotinD/commit/f837b528553837643022e6cabb1f71c402ee2266)), references [#586](https://github.com/kevinch3/NicotinD/issues/586) [#586](https://github.com/kevinch3/NicotinD/issues/586) [#615](https://github.com/kevinch3/NicotinD/issues/615) [#673](https://github.com/kevinch3/NicotinD/issues/673) [#674](https://github.com/kevinch3/NicotinD/issues/674)
## [0.4.8](https://github.com/kevinch3/NicotinD/compare/v0.4.7...v0.4.8) (2026-08-24)

### Bug Fixes

* **addons:** browse follows the declared capability, not method presence ([#672](https://github.com/kevinch3/NicotinD/issues/672)) ([b217813](https://github.com/kevinch3/NicotinD/commit/b217813a18a083bc76d319a1476f0b0dda0aa00e))
## [0.4.7](https://github.com/kevinch3/NicotinD/compare/v0.4.6...v0.4.7) (2026-08-24)

### Bug Fixes

* **acquire:** show honest state words instead of "↓ undefined%" on per-file download buttons ([#668](https://github.com/kevinch3/NicotinD/issues/668)) ([83d513e](https://github.com/kevinch3/NicotinD/commit/83d513e3163bec284f472541acb44c52cd481b79)), references [#496](https://github.com/kevinch3/NicotinD/issues/496) [#667](https://github.com/kevinch3/NicotinD/issues/667)
* **catalog:** distinguish a failed album.lookup from an empty discography, with bounded retry ([#671](https://github.com/kevinch3/NicotinD/issues/671)) ([275c4a6](https://github.com/kevinch3/NicotinD/commit/275c4a62cba7a6c359d1d8d9b4afd96efeaa6ec8)), references [#669](https://github.com/kevinch3/NicotinD/issues/669) [#670](https://github.com/kevinch3/NicotinD/issues/670)
## [0.4.6](https://github.com/kevinch3/NicotinD/compare/v0.4.5...v0.4.6) (2026-08-24)

### Bug Fixes

* **radio:** treat one recording as one thing, not one row per file ([#661](https://github.com/kevinch3/NicotinD/issues/661)) ([a5f1a23](https://github.com/kevinch3/NicotinD/commit/a5f1a2353ef83ef311f18e55269494f29ae4644c)), references [#1](https://github.com/kevinch3/NicotinD/issues/1) [#642](https://github.com/kevinch3/NicotinD/issues/642) [#660](https://github.com/kevinch3/NicotinD/issues/660)
## [0.4.5](https://github.com/kevinch3/NicotinD/compare/v0.4.4...v0.4.5) (2026-08-24)

### Bug Fixes

* **web:** reserve the waveform strip's box so its arrival never shifts the transport ([#659](https://github.com/kevinch3/NicotinD/issues/659)) ([8d13d0d](https://github.com/kevinch3/NicotinD/commit/8d13d0da5a76dd2aae87703d822f4f81d2368bd6)), closes [#657](https://github.com/kevinch3/NicotinD/issues/657)
## [0.4.4](https://github.com/kevinch3/NicotinD/compare/v0.4.3...v0.4.4) (2026-08-24)
## [0.4.3](https://github.com/kevinch3/NicotinD/compare/v0.4.2...v0.4.3) (2026-08-24)

### Bug Fixes

* **acquisition:** generate a native playlist for addon-run playlist jobs ([#656](https://github.com/kevinch3/NicotinD/issues/656)) ([b41252d](https://github.com/kevinch3/NicotinD/commit/b41252d6301a5982d775aaaf0ecbfa9dfd4d4b22)), references [#590](https://github.com/kevinch3/NicotinD/issues/590)
## [0.4.2](https://github.com/kevinch3/NicotinD/compare/v0.4.1...v0.4.2) (2026-08-24)

### Bug Fixes

* **downloads:** a partial download says why it failed, and can be retried ([#653](https://github.com/kevinch3/NicotinD/issues/653)) ([675acf7](https://github.com/kevinch3/NicotinD/commit/675acf7fb144d50e2678bda1289ec507b91c2727)), closes [#652](https://github.com/kevinch3/NicotinD/issues/652), references [#585](https://github.com/kevinch3/NicotinD/issues/585) [#601](https://github.com/kevinch3/NicotinD/issues/601) [#651](https://github.com/kevinch3/NicotinD/issues/651)
## [0.4.1](https://github.com/kevinch3/NicotinD/compare/v0.4.0...v0.4.1) (2026-08-23)
## [0.4.0](https://github.com/kevinch3/NicotinD/compare/v0.3.66...v0.4.0) (2026-08-23)

### Removed

* **Processing window** — background enrichment no longer runs only inside a daily time window; it runs continuously while enabled. Pausing is now the way to stand down.
* **Compute regulator** — the concurrency, batch-size and "yield above N % GPU" controls are gone. Measurement (issue [#224](https://github.com/kevinch3/NicotinD/issues/224)) found the GPU yield changed neither throughput nor GPU memory. Use **Pause** when another application needs the card.
* **Resume playback on app open** — the app never auto-plays on load. Your queue, track and position are still restored exactly as before; only the automatic play is gone.
* **Generation feedback** — the 👍/👎 hunt-match capture and its admin queue. It had stopped recording anything when acquisition moved to addons. Radio evaluation polls are unaffected.

### Changed

* **Admin page reorganised** — User management is now first, followed by Library processing. Each section is its own component, so the order can be changed cheaply from here on.
* Admin no longer blanks the whole page while the user list loads; only that card waits.

## [0.3.66](https://github.com/kevinch3/NicotinD/compare/v0.3.65...v0.3.66) (2026-08-23)
## [0.3.65](https://github.com/kevinch3/NicotinD/compare/v0.3.64...v0.3.65) (2026-08-23)

### Bug Fixes

* **api:** clamp waveform peaks to the -1..1 contract for over-full-scale masters ([#649](https://github.com/kevinch3/NicotinD/issues/649)) ([52a834b](https://github.com/kevinch3/NicotinD/commit/52a834b652a14994d608cc82bb1792660329e0c4)), references [#643](https://github.com/kevinch3/NicotinD/issues/643)
## [0.3.64](https://github.com/kevinch3/NicotinD/compare/v0.3.63...v0.3.64) (2026-08-23)

### Features

* **player:** waveform strip + karaoke VFX from a precomputed peaks artifact ([#648](https://github.com/kevinch3/NicotinD/issues/648)) ([085a23b](https://github.com/kevinch3/NicotinD/commit/085a23b0450aba79211fdd2acc9537b53747ddc6)), references [#640](https://github.com/kevinch3/NicotinD/issues/640) [#643](https://github.com/kevinch3/NicotinD/issues/643) [#438](https://github.com/kevinch3/NicotinD/issues/438) [#643](https://github.com/kevinch3/NicotinD/issues/643) [#457](https://github.com/kevinch3/NicotinD/issues/457)
## [0.3.63](https://github.com/kevinch3/NicotinD/compare/v0.3.62...v0.3.63) (2026-08-23)

### Bug Fixes

* **admin:** run whole-library passes as background jobs, not in the handler ([#645](https://github.com/kevinch3/NicotinD/issues/645)) ([566c6a1](https://github.com/kevinch3/NicotinD/commit/566c6a1752a9f475de9d1a4b7173f7163daa3c83)), references [#622](https://github.com/kevinch3/NicotinD/issues/622)
## [0.3.62](https://github.com/kevinch3/NicotinD/compare/v0.3.61...v0.3.62) (2026-08-23)

### Bug Fixes

* **analysis:** run descriptor extraction in a worker process so /health stays responsive ([#647](https://github.com/kevinch3/NicotinD/issues/647)) ([e76cc76](https://github.com/kevinch3/NicotinD/commit/e76cc760c6efe9dec95a8817879ce7088917727a)), references [#640](https://github.com/kevinch3/NicotinD/issues/640)
## [0.3.61](https://github.com/kevinch3/NicotinD/compare/v0.3.60...v0.3.61) (2026-08-23)

### Features

* **analysis:** per-track audio descriptors (timbre/groove/bands) + descriptor store ([#646](https://github.com/kevinch3/NicotinD/issues/646)) ([3635644](https://github.com/kevinch3/NicotinD/commit/363564404a1c65c797b6fa3f1ddc2165f891363e)), references [#640](https://github.com/kevinch3/NicotinD/issues/640) [#641](https://github.com/kevinch3/NicotinD/issues/641)
## [0.3.60](https://github.com/kevinch3/NicotinD/compare/v0.3.59...v0.3.60) (2026-08-22)

### Features

* list-seeded radio ("keep the vibe") + tastemakers shelf ([#634](https://github.com/kevinch3/NicotinD/issues/634)) ([8c44f5a](https://github.com/kevinch3/NicotinD/commit/8c44f5a50de98d4069c549bcc3e1ea990ee988bc))
## [0.3.59](https://github.com/kevinch3/NicotinD/compare/v0.3.58...v0.3.59) (2026-08-22)
## [0.3.58](https://github.com/kevinch3/NicotinD/compare/v0.3.57...v0.3.58) (2026-08-22)
## [0.3.57](https://github.com/kevinch3/NicotinD/compare/v0.3.56...v0.3.57) (2026-08-22)

### Features

* **ci:** scan for committed secrets and for base-image CVEs ([#633](https://github.com/kevinch3/NicotinD/issues/633)) ([619d350](https://github.com/kevinch3/NicotinD/commit/619d3507286f0469740544912eaf9ce757b0689f)), references [#630](https://github.com/kevinch3/NicotinD/issues/630) [#457](https://github.com/kevinch3/NicotinD/issues/457) [#632](https://github.com/kevinch3/NicotinD/issues/632) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.56](https://github.com/kevinch3/NicotinD/compare/v0.3.55...v0.3.56) (2026-08-22)

### Features

* **ci:** gate the supply chain on what actually ships ([#631](https://github.com/kevinch3/NicotinD/issues/631)) ([d044595](https://github.com/kevinch3/NicotinD/commit/d0445958a5aa54d72a04ff51b44582f2856baedc)), references [#612](https://github.com/kevinch3/NicotinD/issues/612) [#621](https://github.com/kevinch3/NicotinD/issues/621) [#457](https://github.com/kevinch3/NicotinD/issues/457) [#606](https://github.com/kevinch3/NicotinD/issues/606) [#273](https://github.com/kevinch3/NicotinD/issues/273) [#612](https://github.com/kevinch3/NicotinD/issues/612) [#630](https://github.com/kevinch3/NicotinD/issues/630) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.55](https://github.com/kevinch3/NicotinD/compare/v0.3.54...v0.3.55) (2026-08-22)

### Features

* **db:** snapshot the database before a schema migration ([#629](https://github.com/kevinch3/NicotinD/issues/629)) ([6cab6e0](https://github.com/kevinch3/NicotinD/commit/6cab6e0800f31c4f08cf8365894b743004de0df2)), references [#627](https://github.com/kevinch3/NicotinD/issues/627) [457/#606](https://github.com/kevinch3/NicotinD/issues/606) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.54](https://github.com/kevinch3/NicotinD/compare/v0.3.53...v0.3.54) (2026-08-22)

### Features

* **db:** version-gate the five destructive schema migrations ([#628](https://github.com/kevinch3/NicotinD/issues/628)) ([9b715b2](https://github.com/kevinch3/NicotinD/commit/9b715b2fb97412fd7c0bec887338b2d1b0cc738e)), references [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.53](https://github.com/kevinch3/NicotinD/compare/v0.3.52...v0.3.53) (2026-08-22)

### Features

* **db:** make schema migration atomic and stamp a version ([#627](https://github.com/kevinch3/NicotinD/issues/627)) ([cb79fea](https://github.com/kevinch3/NicotinD/commit/cb79fea6e41f2ae844f97c160dcb82fdef775a25)), references [457/#606](https://github.com/kevinch3/NicotinD/issues/606) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.52](https://github.com/kevinch3/NicotinD/compare/v0.3.51...v0.3.52) (2026-08-22)

### Features

* **ci:** gate every outbound fetch on having a timeout, and fix the 7 that did not ([#626](https://github.com/kevinch3/NicotinD/issues/626)) ([94dd480](https://github.com/kevinch3/NicotinD/commit/94dd480ecbfee09d52297027aef10a7986926a55)), references [#623](https://github.com/kevinch3/NicotinD/issues/623) [#625](https://github.com/kevinch3/NicotinD/issues/625) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.51](https://github.com/kevinch3/NicotinD/compare/v0.3.50...v0.3.51) (2026-08-22)

### Bug Fixes

* **musicbrainz:** stop remembering a failure as an absence ([#625](https://github.com/kevinch3/NicotinD/issues/625)) ([08ea100](https://github.com/kevinch3/NicotinD/commit/08ea1006153ca674c7f72e73b6370199febf87bc)), references [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.50](https://github.com/kevinch3/NicotinD/compare/v0.3.49...v0.3.50) (2026-08-22)
## [0.3.49](https://github.com/kevinch3/NicotinD/compare/v0.3.48...v0.3.49) (2026-08-22)

### Bug Fixes

* **lidarr:** bound every Lidarr call, in three tiers ([#623](https://github.com/kevinch3/NicotinD/issues/623)) ([8dc6fe4](https://github.com/kevinch3/NicotinD/commit/8dc6fe439f33c84c9b7aca2bf4c5d5000317467e)), references [#622](https://github.com/kevinch3/NicotinD/issues/622) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.48](https://github.com/kevinch3/NicotinD/compare/v0.3.47...v0.3.48) (2026-08-22)

### Bug Fixes

* **docker:** stop shipping every workspace's devDependencies in the runtime image ([#621](https://github.com/kevinch3/NicotinD/issues/621)) ([136e6c2](https://github.com/kevinch3/NicotinD/commit/136e6c23fbc3c4208ba61426532f2f7aa5ef9aed)), references [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.47](https://github.com/kevinch3/NicotinD/compare/v0.3.46...v0.3.47) (2026-08-22)

### Features

* **ci:** boot the shipped image in CI, and verify the deploy actually landed ([#620](https://github.com/kevinch3/NicotinD/issues/620)) ([85ad675](https://github.com/kevinch3/NicotinD/commit/85ad675e64a0f0bead4fb52b005f4e3f632d0bb5)), references [#457](https://github.com/kevinch3/NicotinD/issues/457) [#457](https://github.com/kevinch3/NicotinD/issues/457) [#606](https://github.com/kevinch3/NicotinD/issues/606) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.46](https://github.com/kevinch3/NicotinD/compare/v0.3.45...v0.3.46) (2026-08-22)

### Features

* **security:** announce the two unsafe shipped defaults before removing them ([#619](https://github.com/kevinch3/NicotinD/issues/619)) ([06d8190](https://github.com/kevinch3/NicotinD/commit/06d8190b3301062d70609eab6eb0f850dbceee8c)), references [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.45](https://github.com/kevinch3/NicotinD/compare/v0.3.44...v0.3.45) (2026-08-21)

### Features

* **history:** record which client a play came from, not just "browser" ([#618](https://github.com/kevinch3/NicotinD/issues/618)) ([964afad](https://github.com/kevinch3/NicotinD/commit/964afad0787149e04abd36f7aeee5f3cfbd391ec))
## [0.3.44](https://github.com/kevinch3/NicotinD/compare/v0.3.43...v0.3.44) (2026-08-21)

### Bug Fixes

* **ci:** check:ci-parity matched by substring and excluded by job ([#617](https://github.com/kevinch3/NicotinD/issues/617)) ([88c6b05](https://github.com/kevinch3/NicotinD/commit/88c6b05240c6a62b9f98cbebacf5850f02e62b16))
## [0.3.43](https://github.com/kevinch3/NicotinD/compare/v0.3.42...v0.3.43) (2026-08-21)

### Bug Fixes

* **ci:** bun's script shell expands ** as one level, so 104 files went unlinted ([#615](https://github.com/kevinch3/NicotinD/issues/615)) ([44d6a1e](https://github.com/kevinch3/NicotinD/commit/44d6a1e0632f09e69bb5b9b71483b29a8cc4f32a)), references [#1](https://github.com/kevinch3/NicotinD/issues/1) [#3](https://github.com/kevinch3/NicotinD/issues/3) [#250](https://github.com/kevinch3/NicotinD/issues/250) [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.42](https://github.com/kevinch3/NicotinD/compare/v0.3.41...v0.3.42) (2026-08-21)

### Bug Fixes

* **ci:** check:claude-md counted prose as proof a symbol exists ([#614](https://github.com/kevinch3/NicotinD/issues/614)) ([5240772](https://github.com/kevinch3/NicotinD/commit/52407729db568ab2af61d322aeae7c80f2290ca1)), references [#612](https://github.com/kevinch3/NicotinD/issues/612)
## [0.3.41](https://github.com/kevinch3/NicotinD/compare/v0.3.40...v0.3.41) (2026-08-21)

### Bug Fixes

* **ci:** check:route-auth audited 24 of 35 route mounts and exited green ([#613](https://github.com/kevinch3/NicotinD/issues/613)) ([3f05179](https://github.com/kevinch3/NicotinD/commit/3f051790289d544e85d3343e3305c07f0be3d9e4)), references [#461](https://github.com/kevinch3/NicotinD/issues/461) [#457](https://github.com/kevinch3/NicotinD/issues/457) [#606](https://github.com/kevinch3/NicotinD/issues/606) [#461](https://github.com/kevinch3/NicotinD/issues/461)
## [0.3.40](https://github.com/kevinch3/NicotinD/compare/v0.3.39...v0.3.40) (2026-08-21)

### Bug Fixes

* **library:** stop artist MBID resolution picking the first of N same-name hits ([#611](https://github.com/kevinch3/NicotinD/issues/611)) ([e9aa00e](https://github.com/kevinch3/NicotinD/commit/e9aa00e906dd515dd0cd9f81c7b34ce0cdc1e0f2)), closes [#610](https://github.com/kevinch3/NicotinD/issues/610), references [#211](https://github.com/kevinch3/NicotinD/issues/211)
## [0.3.39](https://github.com/kevinch3/NicotinD/compare/v0.3.38...v0.3.39) (2026-08-20)

### Bug Fixes

* **analysis:** bound MusiCNN's batch size so the sidecar stops pinning 93% of the GPU ([#607](https://github.com/kevinch3/NicotinD/issues/607)) ([7446ada](https://github.com/kevinch3/NicotinD/commit/7446ada196da977902b029e031fccd07e573e9ee)), closes [#605](https://github.com/kevinch3/NicotinD/issues/605) [#603](https://github.com/kevinch3/NicotinD/issues/603)
* **deploy:** pull every image we publish, derived from compose not a hardcoded list ([#609](https://github.com/kevinch3/NicotinD/issues/609)) ([7f93159](https://github.com/kevinch3/NicotinD/commit/7f931590852314cd0d5bdadbea61f032c99eafe3)), closes [#606](https://github.com/kevinch3/NicotinD/issues/606) [#606](https://github.com/kevinch3/NicotinD/issues/606), references [nicotind-spotdl-addon#4](https://github.com/kevinch3/NicotinD/issues/4) [#457](https://github.com/kevinch3/NicotinD/issues/457) [#606](https://github.com/kevinch3/NicotinD/issues/606)
## [0.3.38](https://github.com/kevinch3/NicotinD/compare/v0.3.37...v0.3.38) (2026-08-20)

### Bug Fixes

* **downloads:** reduce an addon's Python traceback to the line that says what broke ([#604](https://github.com/kevinch3/NicotinD/issues/604)) ([7483d1c](https://github.com/kevinch3/NicotinD/commit/7483d1c10f91a58f53917d15997468463533e277)), references [#601](https://github.com/kevinch3/NicotinD/issues/601)
## [0.3.37](https://github.com/kevinch3/NicotinD/compare/v0.3.36...v0.3.37) (2026-08-20)

### Bug Fixes

* **acquire:** a pasted link shows its Downloads card at once, not up to 30s later ([#596](https://github.com/kevinch3/NicotinD/issues/596)) ([0a497ef](https://github.com/kevinch3/NicotinD/commit/0a497efa22ddb90958bf5751ee3e0844e329b086)), references [#590](https://github.com/kevinch3/NicotinD/issues/590) [#595](https://github.com/kevinch3/NicotinD/issues/595)
* **radio:** genre stations — grade membership (v3), then fix what prod said was wrong (v4) ([#599](https://github.com/kevinch3/NicotinD/issues/599)) ([a614843](https://github.com/kevinch3/NicotinD/commit/a61484305da04783a9fac8a4078c228722d30702)), references [#597](https://github.com/kevinch3/NicotinD/issues/597) [#598](https://github.com/kevinch3/NicotinD/issues/598) [#600](https://github.com/kevinch3/NicotinD/issues/600)
## [0.3.36](https://github.com/kevinch3/NicotinD/compare/v0.3.35...v0.3.36) (2026-08-20)

### Bug Fixes

* **review:** visible Approve on light themes, mobile-safe card, bulk sweep, and no VA single ([#594](https://github.com/kevinch3/NicotinD/issues/594)) ([2ea925c](https://github.com/kevinch3/NicotinD/commit/2ea925c7ac3ca7c9026dfa8dc437917da095e8c2)), closes [#591](https://github.com/kevinch3/NicotinD/issues/591) [#592](https://github.com/kevinch3/NicotinD/issues/592) [#593](https://github.com/kevinch3/NicotinD/issues/593)
## [0.3.35](https://github.com/kevinch3/NicotinD/compare/v0.3.34...v0.3.35) (2026-08-20)

### Bug Fixes

* **downloads:** an active addon job reads Downloading, and queued placeholders close honestly ([#590](https://github.com/kevinch3/NicotinD/issues/590)) ([09c17a9](https://github.com/kevinch3/NicotinD/commit/09c17a9efcd8f24a43e992b81ef1f9486afe08cb)), references [#585](https://github.com/kevinch3/NicotinD/issues/585)
## [0.3.34](https://github.com/kevinch3/NicotinD/compare/v0.3.33...v0.3.34) (2026-08-20)

### Bug Fixes

* **addon-sdk:** count spotDL's mid-run failures live; record the yt-dlp layer-cache root cause ([#588](https://github.com/kevinch3/NicotinD/issues/588)) ([#589](https://github.com/kevinch3/NicotinD/issues/589)) ([68f8dd4](https://github.com/kevinch3/NicotinD/commit/68f8dd49b0d882f3576664274d803e5da091a520)), references [#585](https://github.com/kevinch3/NicotinD/issues/585)
## [0.3.33](https://github.com/kevinch3/NicotinD/compare/v0.3.32...v0.3.33) (2026-08-20)

### Features

* **radio:** formula v2 — poll-calibrated weights, junk-genre fix, 60s pool floor, eval harness ([#584](https://github.com/kevinch3/NicotinD/issues/584)) ([eaf2bdb](https://github.com/kevinch3/NicotinD/commit/eaf2bdba5f766d2e6f02206b80d70b68aeb33822)), references [#1](https://github.com/kevinch3/NicotinD/issues/1) [#2](https://github.com/kevinch3/NicotinD/issues/2) [#187](https://github.com/kevinch3/NicotinD/issues/187)
## [0.3.32](https://github.com/kevinch3/NicotinD/compare/v0.3.31...v0.3.32) (2026-08-20)

### Features

* support ZIP archives as import sources and improve download card titles ([#582](https://github.com/kevinch3/NicotinD/issues/582)) ([a1e87f7](https://github.com/kevinch3/NicotinD/commit/a1e87f77395c282ae91eacf827dd2959fb6ec282)), closes [#586](https://github.com/kevinch3/NicotinD/issues/586), references [#585](https://github.com/kevinch3/NicotinD/issues/585) [#585](https://github.com/kevinch3/NicotinD/issues/585) [#587](https://github.com/kevinch3/NicotinD/issues/587)
## [0.3.31](https://github.com/kevinch3/NicotinD/compare/v0.3.30...v0.3.31) (2026-08-20)

### Features

* **radio:** radio evaluation polls — public anonymous grading of next-track picks ([#581](https://github.com/kevinch3/NicotinD/issues/581)) ([6bf55c2](https://github.com/kevinch3/NicotinD/commit/6bf55c26578cfffbe27930eb0d84a20703bb4b8b)), references [#187](https://github.com/kevinch3/NicotinD/issues/187)
## [0.3.30](https://github.com/kevinch3/NicotinD/compare/v0.3.29...v0.3.30) (2026-08-19)
## [0.3.29](https://github.com/kevinch3/NicotinD/compare/v0.3.28...v0.3.29) (2026-08-19)

### Features

* **storybook:** story the album hunt modal ([#580](https://github.com/kevinch3/NicotinD/issues/580)) ([bc70110](https://github.com/kevinch3/NicotinD/commit/bc701102abc8d7ef14f7e1390e27c77e2bf5324c)), references [#471](https://github.com/kevinch3/NicotinD/issues/471)
* **storybook:** story the peer folder browser ([#579](https://github.com/kevinch3/NicotinD/issues/579)) ([2a015ac](https://github.com/kevinch3/NicotinD/commit/2a015acf745c18a73e84b1ac07674605eefe4262)), references [#471](https://github.com/kevinch3/NicotinD/issues/471) [#471](https://github.com/kevinch3/NicotinD/issues/471)
## [0.3.28](https://github.com/kevinch3/NicotinD/compare/v0.3.27...v0.3.28) (2026-08-19)

### Features

* **storybook:** story the typed identify failures ([#578](https://github.com/kevinch3/NicotinD/issues/578)) ([ff5a1d8](https://github.com/kevinch3/NicotinD/commit/ff5a1d865b832b6f21d335827ce6eb4fdff92042)), references [#471](https://github.com/kevinch3/NicotinD/issues/471) [#472](https://github.com/kevinch3/NicotinD/issues/472)
## [0.3.27](https://github.com/kevinch3/NicotinD/compare/v0.3.26...v0.3.27) (2026-08-19)

### Features

* **storybook:** story the artist image menu ([#577](https://github.com/kevinch3/NicotinD/issues/577)) ([af37c77](https://github.com/kevinch3/NicotinD/commit/af37c774ec231a30976471a4c0ea671d898feb46)), references [#422](https://github.com/kevinch3/NicotinD/issues/422) [#471](https://github.com/kevinch3/NicotinD/issues/471)
## [0.3.26](https://github.com/kevinch3/NicotinD/compare/v0.3.25...v0.3.26) (2026-08-19)

### Features

* **storybook:** story the download-review inbox ([#576](https://github.com/kevinch3/NicotinD/issues/576)) ([b882231](https://github.com/kevinch3/NicotinD/commit/b882231d6804ac203f48978d6b23a0e8b8d2b966)), references [#471](https://github.com/kevinch3/NicotinD/issues/471)
## [0.3.25](https://github.com/kevinch3/NicotinD/compare/v0.3.24...v0.3.25) (2026-08-19)

### Features

* **storybook:** story the track-info sheet ([#575](https://github.com/kevinch3/NicotinD/issues/575)) ([65141ca](https://github.com/kevinch3/NicotinD/commit/65141cad47f7d8345fb76aef89c8529cc436eb44))
## [0.3.24](https://github.com/kevinch3/NicotinD/compare/v0.3.23...v0.3.24) (2026-08-19)

### Features

* **storybook:** add an en/es language toolbar global ([#567](https://github.com/kevinch3/NicotinD/issues/567)) ([fe738cc](https://github.com/kevinch3/NicotinD/commit/fe738ccbc8ffc214773de8e89fd6d2c6ae3586a4))
* **storybook:** catalog the shared directives and the t pipe ([#568](https://github.com/kevinch3/NicotinD/issues/568)) ([2503366](https://github.com/kevinch3/NicotinD/commit/25033661e8a2cc09d89649756e7d06dbd3525ca6))
* **storybook:** interaction tests for menu-panel and seek-bar ([#572](https://github.com/kevinch3/NicotinD/issues/572)) ([a8d4bf7](https://github.com/kevinch3/NicotinD/commit/a8d4bf7477f54fc64b5b4ab122e5044b474f10b4))
* **storybook:** story bottom-nav and seed download state ([#573](https://github.com/kevinch3/NicotinD/issues/573)) ([a9076b7](https://github.com/kevinch3/NicotinD/commit/a9076b7e8e4f86b3de04859fdbe65213c2119dce)), references [#472](https://github.com/kevinch3/NicotinD/issues/472)
* **storybook:** story the hunt-feedback grading sheet ([#574](https://github.com/kevinch3/NicotinD/issues/574)) ([da95d3d](https://github.com/kevinch3/NicotinD/commit/da95d3da515e93483ea3588183cc7c1a69557e03)), references [#472](https://github.com/kevinch3/NicotinD/issues/472)

### Bug Fixes

* **downloads:** only deep-link a job to an album it actually landed in ([#560](https://github.com/kevinch3/NicotinD/issues/560)) ([2350276](https://github.com/kevinch3/NicotinD/commit/23502760d2eb1856b4b202824ade412c98f38be0)), references [#261](https://github.com/kevinch3/NicotinD/issues/261)
* **mobile:** prove the cover URL reachable before handing it to the media session ([#566](https://github.com/kevinch3/NicotinD/issues/566)) ([7d692e8](https://github.com/kevinch3/NicotinD/commit/7d692e8ad52940b8188674c97c845391af59d14b))
* **tv:** let a clamped vertical arrow escape a nav group ([#569](https://github.com/kevinch3/NicotinD/issues/569)) ([6a467cd](https://github.com/kevinch3/NicotinD/commit/6a467cd2090bbcf385914500d5240d202ad29dc6)), references [#436](https://github.com/kevinch3/NicotinD/issues/436)
* **web:** route admin SSE streams through an ngsw-bypass helper ([#558](https://github.com/kevinch3/NicotinD/issues/558)) ([5c1cbf5](https://github.com/kevinch3/NicotinD/commit/5c1cbf5a4e3abf4b663b0437e812c8072a9f54ee))
## [0.3.23](https://github.com/kevinch3/NicotinD/compare/v0.3.22...v0.3.23) (2026-08-19)

### Features

* **library:** acoustid fingerprint identify + apply in the track-info sheet ([#555](https://github.com/kevinch3/NicotinD/issues/555)) ([799e6b2](https://github.com/kevinch3/NicotinD/commit/799e6b2b24d5c7df34c8cc0b3cb328f2a59999a6))
## [0.3.22](https://github.com/kevinch3/NicotinD/compare/v0.3.21...v0.3.22) (2026-08-19)

### Features

* **pot-provider:** publish the bgutil version as an image label ([#553](https://github.com/kevinch3/NicotinD/issues/553)) ([d9272db](https://github.com/kevinch3/NicotinD/commit/d9272db2361cff4f58eb4708e6a4d4ed7ffce2a6)), references [#550](https://github.com/kevinch3/NicotinD/issues/550) [#551](https://github.com/kevinch3/NicotinD/issues/551)
## [0.3.21](https://github.com/kevinch3/NicotinD/compare/v0.3.20...v0.3.21) (2026-08-19)

### Bug Fixes

* **acquire:** make addon URL submits idempotent and visible to the link card ([#546](https://github.com/kevinch3/NicotinD/issues/546)) ([32a6194](https://github.com/kevinch3/NicotinD/commit/32a61947d8dc2c81c3f096b0dd65bf29200a62f8))
* **docker:** install libchromaprint-tools so AcoustID identify works ([#549](https://github.com/kevinch3/NicotinD/issues/549)) ([66a440e](https://github.com/kevinch3/NicotinD/commit/66a440e7ef0957b89374b3be8edea8940e0e66f2))
## [0.3.20](https://github.com/kevinch3/NicotinD/compare/v0.3.19...v0.3.20) (2026-08-18)

### Features

* **web:** shape-matched skeleton loaders for every fetching list view ([#544](https://github.com/kevinch3/NicotinD/issues/544)) ([c6a0639](https://github.com/kevinch3/NicotinD/commit/c6a0639b780b8d5bdc51e1f6586e5132f33f9f61))
## [0.3.19](https://github.com/kevinch3/NicotinD/compare/v0.3.18...v0.3.19) (2026-08-18)

### Bug Fixes

* **analysis:** report idle-released registry as ok in /health, not unavailable ([#542](https://github.com/kevinch3/NicotinD/issues/542)) ([fd81db6](https://github.com/kevinch3/NicotinD/commit/fd81db6a6d4c9db89390740b5e8cf7dc99a906fb)), references [#224](https://github.com/kevinch3/NicotinD/issues/224) [#539](https://github.com/kevinch3/NicotinD/issues/539)
## [0.3.18](https://github.com/kevinch3/NicotinD/compare/v0.3.17...v0.3.18) (2026-08-18)

### Bug Fixes

* **downloads:** repair post-cutover hunt and feed regressions ([#537](https://github.com/kevinch3/NicotinD/issues/537)) ([b1832fb](https://github.com/kevinch3/NicotinD/commit/b1832fb810455830509e9fd7933aa64d6835833b)), references [#530](https://github.com/kevinch3/NicotinD/issues/530) [#531](https://github.com/kevinch3/NicotinD/issues/531) [#532](https://github.com/kevinch3/NicotinD/issues/532) [#533](https://github.com/kevinch3/NicotinD/issues/533) [#534](https://github.com/kevinch3/NicotinD/issues/534)
## [0.3.17](https://github.com/kevinch3/NicotinD/compare/v0.3.16...v0.3.17) (2026-08-18)

### Features

* artist origin (nationality) metadata - radio axis, filter, recipes, artist page ([#536](https://github.com/kevinch3/NicotinD/issues/536)) ([888b77c](https://github.com/kevinch3/NicotinD/commit/888b77c593d46c1386241af0a04ebeca96e0399d)), references [#538](https://github.com/kevinch3/NicotinD/issues/538)
## [0.3.16](https://github.com/kevinch3/NicotinD/compare/v0.3.15...v0.3.16) (2026-08-18)

### Bug Fixes

* **web:** render the artist photo edit control ([#535](https://github.com/kevinch3/NicotinD/issues/535)) ([9cd77e2](https://github.com/kevinch3/NicotinD/commit/9cd77e257da2a82a78a29e133bd328de99958d7e))
## [0.3.15](https://github.com/kevinch3/NicotinD/compare/v0.3.14...v0.3.15) (2026-08-18)

### Features

* **admin:** last connection + consolidate the user management table ([#529](https://github.com/kevinch3/NicotinD/issues/529)) ([9e0f0f4](https://github.com/kevinch3/NicotinD/commit/9e0f0f4f8cc6be2e122e84aed8c9d5cf2c9e8f31))
## [0.3.14](https://github.com/kevinch3/NicotinD/compare/v0.3.13...v0.3.14) (2026-08-18)

### Bug Fixes

* **web:** real cover art on home resume + recently-played tiles ([#528](https://github.com/kevinch3/NicotinD/issues/528)) ([5074d20](https://github.com/kevinch3/NicotinD/commit/5074d200f23213d002569ac52563da0630ef2748))
## [0.3.13](https://github.com/kevinch3/NicotinD/compare/v0.3.12...v0.3.13) (2026-08-17)
## [0.3.12](https://github.com/kevinch3/NicotinD/compare/v0.3.11...v0.3.12) (2026-08-17)

### Features

* **hunt:** surface slskd rate-limiting as "keep trying" vs a genuine miss ([#526](https://github.com/kevinch3/NicotinD/issues/526)) ([eb834ac](https://github.com/kevinch3/NicotinD/commit/eb834aca0cc90120112162ea7ed68426accf859c)), references [#hunt-429](https://github.com/kevinch3/NicotinD/issues/hunt-429)
## [0.3.11](https://github.com/kevinch3/NicotinD/compare/v0.3.10...v0.3.11) (2026-08-17)

### Features

* **library:** import music from a server folder through the download pipeline ([#512](https://github.com/kevinch3/NicotinD/issues/512)) ([8abea4d](https://github.com/kevinch3/NicotinD/commit/8abea4d19c61058396e21b8141ccd8390a698681))
## [0.3.10](https://github.com/kevinch3/NicotinD/compare/v0.3.9...v0.3.10) (2026-08-16)
## [0.3.9](https://github.com/kevinch3/NicotinD/compare/v0.3.8...v0.3.9) (2026-08-15)

### Bug Fixes

* **addons:** slskd catalog id is the manifest id (slskd), not the service name ([#524](https://github.com/kevinch3/NicotinD/issues/524)) ([9104eb9](https://github.com/kevinch3/NicotinD/commit/9104eb90d2d5942c2940c5f22e08318d50ecea89)), references [#517](https://github.com/kevinch3/NicotinD/issues/517) [#517](https://github.com/kevinch3/NicotinD/issues/517)
## [0.3.8](https://github.com/kevinch3/NicotinD/compare/v0.3.7...v0.3.8) (2026-08-15)

### Features

* **addons:** addon manifest preview + shareable install link/QR ([#523](https://github.com/kevinch3/NicotinD/issues/523)) ([f99f7b2](https://github.com/kevinch3/NicotinD/commit/f99f7b224005f550b17fcab76d3de30176438493)), closes [#522](https://github.com/kevinch3/NicotinD/issues/522), references [#517](https://github.com/kevinch3/NicotinD/issues/517) [#517](https://github.com/kevinch3/NicotinD/issues/517)
* **addons:** one-click addon install — token mint + pending registration + auto-detect ([#521](https://github.com/kevinch3/NicotinD/issues/521)) ([de421db](https://github.com/kevinch3/NicotinD/commit/de421dba706b504e576717716f30eb2bd08ca8b5)), closes [#520](https://github.com/kevinch3/NicotinD/issues/520), references [#517](https://github.com/kevinch3/NicotinD/issues/517) [#517](https://github.com/kevinch3/NicotinD/issues/517)
## [0.3.7](https://github.com/kevinch3/NicotinD/compare/v0.3.6...v0.3.7) (2026-08-15)

### Features

* **addons:** curated addon marketplace — read-only "Available add-ons" section ([#519](https://github.com/kevinch3/NicotinD/issues/519)) ([4264987](https://github.com/kevinch3/NicotinD/commit/4264987691791da9f4ddf9aec75e29558e0962c3)), closes [#518](https://github.com/kevinch3/NicotinD/issues/518), references [#517](https://github.com/kevinch3/NicotinD/issues/517) [#517](https://github.com/kevinch3/NicotinD/issues/517)
## [0.3.6](https://github.com/kevinch3/NicotinD/compare/v0.3.5...v0.3.6) (2026-08-15)

### Bug Fixes

* **addons:** reconcile orphaned addon jobs + fix URL-job feed rendering ([#516](https://github.com/kevinch3/NicotinD/issues/516)) ([2d32694](https://github.com/kevinch3/NicotinD/commit/2d3269473dc7f228aecd46b975c29a225cf09098))
## [0.3.5](https://github.com/kevinch3/NicotinD/compare/v0.3.4...v0.3.5) (2026-08-15)

### Features

* **addons:** remove the in-process spotdl plugin (external addon cutover) ([#514](https://github.com/kevinch3/NicotinD/issues/514)) ([0e1b328](https://github.com/kevinch3/NicotinD/commit/0e1b32884ed4c6e26395b3579e720c8e8fbb3945))
## [0.3.4](https://github.com/kevinch3/NicotinD/compare/v0.3.3...v0.3.4) (2026-08-15)

### Features

* **addons:** yt-dlp becomes an external addon (core cutover) ([#513](https://github.com/kevinch3/NicotinD/issues/513)) ([1131a3d](https://github.com/kevinch3/NicotinD/commit/1131a3d43fafe788a069f193026aff0e3c9bee7c)), references [#486](https://github.com/kevinch3/NicotinD/issues/486)
## [0.3.3](https://github.com/kevinch3/NicotinD/compare/v0.3.2...v0.3.3) (2026-08-14)

### Features

* resolve-addons url seam + archive as a bundled built-in addon ([#511](https://github.com/kevinch3/NicotinD/issues/511)) ([3b52ab3](https://github.com/kevinch3/NicotinD/commit/3b52ab3930186ece100ea76306c323f2960ca7f2)), closes [#509](https://github.com/kevinch3/NicotinD/issues/509), references [#486](https://github.com/kevinch3/NicotinD/issues/486) [#509](https://github.com/kevinch3/NicotinD/issues/509) [#509](https://github.com/kevinch3/NicotinD/issues/509)
## [0.3.2](https://github.com/kevinch3/NicotinD/compare/v0.3.1...v0.3.2) (2026-08-14)

### Features

* **web:** add a Like heart to the player for quick interaction ([#510](https://github.com/kevinch3/NicotinD/issues/510)) ([c1d4f87](https://github.com/kevinch3/NicotinD/commit/c1d4f8765f57c980afa5669d58247d8363da3723))
## [0.3.1](https://github.com/kevinch3/NicotinD/compare/v0.3.0...v0.3.1) (2026-08-14)
## [0.3.0](https://github.com/kevinch3/NicotinD/compare/v0.2.7...v0.3.0) (2026-08-14)

### ⚠ BREAKING CHANGES

* an acquisition (slskd) deployment must run the external
  slskd-addon image (compose --profile slskd-addon pulls it); the addon is no
  longer built from the monorepo. Streaming-only deploys are unaffected.

  No behavior change for core: typecheck x4, 2983 tests, lint, check:claude-md,
  check:ci-parity, both compose configs, and the root docker image all green.

### Features

* phase 4 cutover — delete slskd packages, point compose at the published image ([#507](https://github.com/kevinch3/NicotinD/issues/507)) ([bb42316](https://github.com/kevinch3/NicotinD/commit/bb4231679fea1dc442819818375d13d88eb0e8aa)), references [#491](https://github.com/kevinch3/NicotinD/issues/491) [#486](https://github.com/kevinch3/NicotinD/issues/486)
## [0.2.7](https://github.com/kevinch3/NicotinD/compare/v0.2.6...v0.2.7) (2026-08-14)
## [0.2.6](https://github.com/kevinch3/NicotinD/compare/v0.2.5...v0.2.6) (2026-08-13)
## [0.2.5](https://github.com/kevinch3/NicotinD/compare/v0.2.4...v0.2.5) (2026-08-13)
## [0.2.4](https://github.com/kevinch3/NicotinD/compare/v0.2.3...v0.2.4) (2026-08-13)

### Bug Fixes

* **streaming:** serve suffix ranges correctly and keep Content-Length on transcoded streams ([#502](https://github.com/kevinch3/NicotinD/issues/502)) ([6171da7](https://github.com/kevinch3/NicotinD/commit/6171da75a495947446cfb7855a1b447c375bb4c8))
## [0.2.3](https://github.com/kevinch3/NicotinD/compare/v0.2.2...v0.2.3) (2026-08-13)

### Features

* **addon-security:** protocol security & contract foundation ([#501](https://github.com/kevinch3/NicotinD/issues/501)) ([9b13c79](https://github.com/kevinch3/NicotinD/commit/9b13c79eb9a1edf31315b525e6893642396ef614))
## [0.2.2](https://github.com/kevinch3/NicotinD/compare/v0.2.1...v0.2.2) (2026-08-13)

### Bug Fixes

* **web:** remove the broken "tap to resume" autoplay banner ([#500](https://github.com/kevinch3/NicotinD/issues/500)) ([d69ad2a](https://github.com/kevinch3/NicotinD/commit/d69ad2acfa7b231399d15f9c11c4c1205b99356a))
## [0.2.1](https://github.com/kevinch3/NicotinD/compare/v0.2.0...v0.2.1) (2026-08-13)

### Bug Fixes

* **desktop:** unbreak resource staging — strip devDeps + demote api's addon dep ([#499](https://github.com/kevinch3/NicotinD/issues/499)) ([455b002](https://github.com/kevinch3/NicotinD/commit/455b002486b71b5e7f5434ec7767f18f7288d94e))
## [0.2.0](https://github.com/kevinch3/NicotinD/compare/v0.1.347...v0.2.0) (2026-08-13)

### ⚠ BREAKING CHANGES

* /api/settings/soulseek*, /api/settings/shares* and the
  setup wizard's Soulseek step are removed; configure Soulseek on the slskd
  addon's Extensions card instead.
* the built-in Soulseek (slskd) extension no longer exists;
  deploy the slskd addon (docker compose --profile slskd-addon) and register
  it under Settings → Extensions to keep acquiring from Soulseek.
* the raw per-transfer download endpoints are removed; use
  the job-level actions.
* the SOULSEEK_USERNAME/SOULSEEK_PASSWORD/NICOTIND_SLSKD_URL
  envs and the soulseek/slskd config sections are gone; Soulseek acquisition
  requires the external slskd addon (docker compose --profile slskd-addon),
  registered via Extensions.

### Features

* phase 3 — delete slskd from core ([#496](https://github.com/kevinch3/NicotinD/issues/496)) ([58678d0](https://github.com/kevinch3/NicotinD/commit/58678d03c50b65cced953ee791036ce0aa0999d7)), references [#487](https://github.com/kevinch3/NicotinD/issues/487) [#488](https://github.com/kevinch3/NicotinD/issues/488) [#488](https://github.com/kevinch3/NicotinD/issues/488) [#489](https://github.com/kevinch3/NicotinD/issues/489) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490) [#490](https://github.com/kevinch3/NicotinD/issues/490)
## [0.1.347](https://github.com/kevinch3/NicotinD/compare/v0.1.346...v0.1.347) (2026-08-13)

### Bug Fixes

* **slskd-addon:** make the addon image buildable + gate it in CI ([#498](https://github.com/kevinch3/NicotinD/issues/498)) ([101e94d](https://github.com/kevinch3/NicotinD/commit/101e94d0ecb0edff7af351a6801aaef3f02e587b))
## [0.1.346](https://github.com/kevinch3/NicotinD/compare/v0.1.345...v0.1.346) (2026-08-12)
## [0.1.345](https://github.com/kevinch3/NicotinD/compare/v0.1.344...v0.1.345) (2026-08-12)

### Features

* **addons:** phase 2 spine — core speaks the protocol when an addon is enabled ([#495](https://github.com/kevinch3/NicotinD/issues/495)) ([a89b310](https://github.com/kevinch3/NicotinD/commit/a89b310b45f92809a0c060cbc64eb59d344e0305)), references [#487](https://github.com/kevinch3/NicotinD/issues/487) [#488](https://github.com/kevinch3/NicotinD/issues/488) [#488](https://github.com/kevinch3/NicotinD/issues/488) [#489](https://github.com/kevinch3/NicotinD/issues/489)
## [0.1.344](https://github.com/kevinch3/NicotinD/compare/v0.1.343...v0.1.344) (2026-08-12)

### Features

* **addons:** acquisition addon protocol phase 0 — remote addon runtime ([#497](https://github.com/kevinch3/NicotinD/issues/497)) ([2a09771](https://github.com/kevinch3/NicotinD/commit/2a097710be95d9050890f9e3348f946891911172)), references [#487](https://github.com/kevinch3/NicotinD/issues/487)
* **slskd-addon:** phase 1 — the in-monorepo slskd addon with the moved hunt engine ([#494](https://github.com/kevinch3/NicotinD/issues/494)) ([2586982](https://github.com/kevinch3/NicotinD/commit/2586982216b10e244be47b1eae358758dcbf205c)), references [#487](https://github.com/kevinch3/NicotinD/issues/487) [#488](https://github.com/kevinch3/NicotinD/issues/488) [#488](https://github.com/kevinch3/NicotinD/issues/488)
## [0.1.343](https://github.com/kevinch3/NicotinD/compare/v0.1.342...v0.1.343) (2026-08-12)
## [0.1.342](https://github.com/kevinch3/NicotinD/compare/v0.1.341...v0.1.342) (2026-08-11)

### Bug Fixes

* **a11y:** clear every axe contrast violation and gate on it ([#485](https://github.com/kevinch3/NicotinD/issues/485)) ([62d1ed8](https://github.com/kevinch3/NicotinD/commit/62d1ed82b009008a536f0a88fa489b2b3f7321cc)), closes [#481](https://github.com/kevinch3/NicotinD/issues/481) [#482](https://github.com/kevinch3/NicotinD/issues/482), references [#fff](https://github.com/kevinch3/NicotinD/issues/fff)
## [0.1.341](https://github.com/kevinch3/NicotinD/compare/v0.1.340...v0.1.341) (2026-08-11)

### Features

* **storybook:** add the a11y addon and fix the button-name violations ([#484](https://github.com/kevinch3/NicotinD/issues/484)) ([889ec2f](https://github.com/kevinch3/NicotinD/commit/889ec2fcff728c46081cacb8243c342cfb47471b)), closes [#474](https://github.com/kevinch3/NicotinD/issues/474), references [#481](https://github.com/kevinch3/NicotinD/issues/481) [#482](https://github.com/kevinch3/NicotinD/issues/482) [481/#482](https://github.com/kevinch3/NicotinD/issues/482)
## [0.1.340](https://github.com/kevinch3/NicotinD/compare/v0.1.339...v0.1.340) (2026-08-11)
## [0.1.339](https://github.com/kevinch3/NicotinD/compare/v0.1.338...v0.1.339) (2026-08-11)
## [0.1.338](https://github.com/kevinch3/NicotinD/compare/v0.1.337...v0.1.338) (2026-08-10)

### Bug Fixes

* **library:** tell a quarantined album apart from a missing one ([#466](https://github.com/kevinch3/NicotinD/issues/466)) ([#469](https://github.com/kevinch3/NicotinD/issues/469)) ([7e4a3cf](https://github.com/kevinch3/NicotinD/commit/7e4a3cf0aa40d33502826ceccb438a1821d71d0e)), closes [#467](https://github.com/kevinch3/NicotinD/issues/467), references [#337](https://github.com/kevinch3/NicotinD/issues/337) [#468](https://github.com/kevinch3/NicotinD/issues/468)
## [0.1.337](https://github.com/kevinch3/NicotinD/compare/v0.1.336...v0.1.337) (2026-08-10)
## [0.1.336](https://github.com/kevinch3/NicotinD/compare/v0.1.335...v0.1.336) (2026-08-10)

### Features

* **privacy:** consent, export, erasure and retention for listening history ([#465](https://github.com/kevinch3/NicotinD/issues/465)) ([bd78174](https://github.com/kevinch3/NicotinD/commit/bd7817484047e603aa12121c300f3d8b698afe9b)), closes [#454](https://github.com/kevinch3/NicotinD/issues/454), references [#235](https://github.com/kevinch3/NicotinD/issues/235) [pre-#454](https://github.com/kevinch3/NicotinD/issues/454)
## [0.1.335](https://github.com/kevinch3/NicotinD/compare/v0.1.334...v0.1.335) (2026-08-10)

### Bug Fixes

* **api:** put /api/radio and /api/catalog behind auth ([#463](https://github.com/kevinch3/NicotinD/issues/463)) ([71e5c79](https://github.com/kevinch3/NicotinD/commit/71e5c79b11d1e454f808576e611a403aeb2eec4d)), closes [#461](https://github.com/kevinch3/NicotinD/issues/461), references [#232](https://github.com/kevinch3/NicotinD/issues/232)
## [0.1.334](https://github.com/kevinch3/NicotinD/compare/v0.1.333...v0.1.334) (2026-08-10)

### Features

* **radio:** demote tracks this listener played recently ([#462](https://github.com/kevinch3/NicotinD/issues/462)) ([e8f2657](https://github.com/kevinch3/NicotinD/commit/e8f265737e4ad3aa1877a50f041a04bbc81450cc)), references [#461](https://github.com/kevinch3/NicotinD/issues/461) [#461](https://github.com/kevinch3/NicotinD/issues/461)
## [0.1.333](https://github.com/kevinch3/NicotinD/compare/v0.1.332...v0.1.333) (2026-08-10)

### Bug Fixes

* **deploy:** a failed image build must not produce a green deploy ([#460](https://github.com/kevinch3/NicotinD/issues/460)) ([12edbd1](https://github.com/kevinch3/NicotinD/commit/12edbd1ccaa345b38d754373429f8b92e6daebbb)), closes [#457](https://github.com/kevinch3/NicotinD/issues/457)
## [0.1.332](https://github.com/kevinch3/NicotinD/compare/v0.1.331...v0.1.332) (2026-08-10)

### Features

* **library:** capture sample rate, bit depth & channel count at scan time ([#459](https://github.com/kevinch3/NicotinD/issues/459)) ([1c5d5ae](https://github.com/kevinch3/NicotinD/commit/1c5d5ae3ba912fef7899f0fdbf91cf3222ee7eab))
## [0.1.331](https://github.com/kevinch3/NicotinD/compare/v0.1.330...v0.1.331) (2026-08-10)
## [0.1.330](https://github.com/kevinch3/NicotinD/compare/v0.1.329...v0.1.330) (2026-08-10)

### Features

* **history:** Library Stats tab over the listening log ([#456](https://github.com/kevinch3/NicotinD/issues/456)) ([155a861](https://github.com/kevinch3/NicotinD/commit/155a86107dafdd6c78efc974e8ebb5b561b5c8e7)), references [#454](https://github.com/kevinch3/NicotinD/issues/454) [#454](https://github.com/kevinch3/NicotinD/issues/454)
## [0.1.329](https://github.com/kevinch3/NicotinD/compare/v0.1.328...v0.1.329) (2026-08-10)

### Features

* **history:** per-user listening log + Recently played shelf ([#455](https://github.com/kevinch3/NicotinD/issues/455)) ([8c0fc44](https://github.com/kevinch3/NicotinD/commit/8c0fc44465a5ddfa62c4291ac57bc5acbac5e123)), references [#454](https://github.com/kevinch3/NicotinD/issues/454) [#273](https://github.com/kevinch3/NicotinD/issues/273) [#376](https://github.com/kevinch3/NicotinD/issues/376) [#376](https://github.com/kevinch3/NicotinD/issues/376)
## [0.1.328](https://github.com/kevinch3/NicotinD/compare/v0.1.327...v0.1.328) (2026-08-10)

### Bug Fixes

* **feedback:** fire the capture prompt on the auto-hunt path; add an admin review queue ([#452](https://github.com/kevinch3/NicotinD/issues/452)) ([435887f](https://github.com/kevinch3/NicotinD/commit/435887f9ae0473ad36b7d3305533ded742713945)), references [#451](https://github.com/kevinch3/NicotinD/issues/451)
## [0.1.327](https://github.com/kevinch3/NicotinD/compare/v0.1.326...v0.1.327) (2026-08-09)

### Features

* **web:** merge Acquire + Downloads into /get; add a Library cross-type find bar ([#447](https://github.com/kevinch3/NicotinD/issues/447)) ([16368ef](https://github.com/kevinch3/NicotinD/commit/16368ef703d0b13775182e65800bf088e89b5bb0)), closes [#444](https://github.com/kevinch3/NicotinD/issues/444), references [#227](https://github.com/kevinch3/NicotinD/issues/227) [#7](https://github.com/kevinch3/NicotinD/issues/7)

### Bug Fixes

* **web:** derive lyricsOpen from activePanel so the persisted Now Playing panel matches the screen ([#450](https://github.com/kevinch3/NicotinD/issues/450)) ([7ae7771](https://github.com/kevinch3/NicotinD/commit/7ae7771f14313ea59d66602e55a2d77a03a37ac3)), closes [#446](https://github.com/kevinch3/NicotinD/issues/446)
## [0.1.326](https://github.com/kevinch3/NicotinD/compare/v0.1.325...v0.1.326) (2026-08-09)

### Bug Fixes

* **web:** recover from a coalesced offline/online flip instead of stalling 20s ([#449](https://github.com/kevinch3/NicotinD/issues/449)) ([878a101](https://github.com/kevinch3/NicotinD/commit/878a1010255626db52c33ffef1829ea987c664fc)), closes [#448](https://github.com/kevinch3/NicotinD/issues/448), references [#447](https://github.com/kevinch3/NicotinD/issues/447)
## [0.1.325](https://github.com/kevinch3/NicotinD/compare/v0.1.324...v0.1.325) (2026-08-08)
## [0.1.324](https://github.com/kevinch3/NicotinD/compare/v0.1.323...v0.1.324) (2026-08-08)

### Features

* **web:** the TV surface — five routes, no form controls ([#442](https://github.com/kevinch3/NicotinD/issues/442)) ([0154175](https://github.com/kevinch3/NicotinD/commit/0154175cb6e53cd80b909ca5de94a48fc90ec65e)), references [#436](https://github.com/kevinch3/NicotinD/issues/436) [#438](https://github.com/kevinch3/NicotinD/issues/438) [#436](https://github.com/kevinch3/NicotinD/issues/436) [#387](https://github.com/kevinch3/NicotinD/issues/387) [#438](https://github.com/kevinch3/NicotinD/issues/438)
## [0.1.323](https://github.com/kevinch3/NicotinD/compare/v0.1.322...v0.1.323) (2026-08-08)

### Bug Fixes

* **review:** distinguish fpcalc failure from a fingerprint no-match ([#430](https://github.com/kevinch3/NicotinD/issues/430)) ([52b7bcd](https://github.com/kevinch3/NicotinD/commit/52b7bcd86d8d5644b3f7ff3dc38bc13ac053c5bc)), closes [#414](https://github.com/kevinch3/NicotinD/issues/414)
## [0.1.322](https://github.com/kevinch3/NicotinD/compare/v0.1.321...v0.1.322) (2026-08-08)

### Bug Fixes

* **review:** hold-for-review is inert while acquisition is off + [#411](https://github.com/kevinch3/NicotinD/issues/411) ledger minors ([#427](https://github.com/kevinch3/NicotinD/issues/427)) ([d1000f9](https://github.com/kevinch3/NicotinD/commit/d1000f9b682670f0b22b635839c75c92637ebe95)), closes [#416](https://github.com/kevinch3/NicotinD/issues/416), references [#235](https://github.com/kevinch3/NicotinD/issues/235)
## [0.1.321](https://github.com/kevinch3/NicotinD/compare/v0.1.320...v0.1.321) (2026-08-08)

### Bug Fixes

* **web:** stop the collapsed TV player bleeding its blurred backdrop (refs [#439](https://github.com/kevinch3/NicotinD/issues/439)) ([#440](https://github.com/kevinch3/NicotinD/issues/440)) ([d077edc](https://github.com/kevinch3/NicotinD/commit/d077edca6a4400c2e6e4fa3c5befbc3900b4c0eb)), references [#399](https://github.com/kevinch3/NicotinD/issues/399)
## [0.1.320](https://github.com/kevinch3/NicotinD/compare/v0.1.319...v0.1.320) (2026-08-07)
## [0.1.319](https://github.com/kevinch3/NicotinD/compare/v0.1.318...v0.1.319) (2026-08-07)

### Features

* **library:** discogs artist images + availability-gated auto-fetch option ([#423](https://github.com/kevinch3/NicotinD/issues/423)) ([fdaad71](https://github.com/kevinch3/NicotinD/commit/fdaad71019d74727f7bfd3b3683128de0af92852)), closes [#422](https://github.com/kevinch3/NicotinD/issues/422)
* **review:** apply the MusicBrainz canonical tracklist to the track grid ([#431](https://github.com/kevinch3/NicotinD/issues/431)) ([128e761](https://github.com/kevinch3/NicotinD/commit/128e761d11d7f8984383cb156303fe6492e26edc)), closes [#413](https://github.com/kevinch3/NicotinD/issues/413)

### Bug Fixes

* **devices:** open the paired-devices card by default ([#424](https://github.com/kevinch3/NicotinD/issues/424)) ([f940880](https://github.com/kevinch3/NicotinD/commit/f940880390f57b6d960cdf32e15dd6b29a8aafa7)), closes [#379](https://github.com/kevinch3/NicotinD/issues/379)
* **tv:** D-pad-reachable player notch, self-healing remote playback, Settings scan button ([#435](https://github.com/kevinch3/NicotinD/issues/435)) ([3bf059f](https://github.com/kevinch3/NicotinD/commit/3bf059f7dd0795dbf128e3e8e19135d60bb0e860)), references [#433](https://github.com/kevinch3/NicotinD/issues/433) [#432](https://github.com/kevinch3/NicotinD/issues/432) [#434](https://github.com/kevinch3/NicotinD/issues/434)
* **web:** adopt page-title across browse/detail-tier page headings ([#425](https://github.com/kevinch3/NicotinD/issues/425)) ([e0cd485](https://github.com/kevinch3/NicotinD/commit/e0cd485749f7c788e059e91034908f8dc70775e6)), closes [#385](https://github.com/kevinch3/NicotinD/issues/385)
## [0.1.318](https://github.com/kevinch3/NicotinD/compare/v0.1.317...v0.1.318) (2026-08-06)

### Bug Fixes

* **web:** unify the settings family on admin's max-w-3xl page-shell tier ([#421](https://github.com/kevinch3/NicotinD/issues/421)) ([fae4405](https://github.com/kevinch3/NicotinD/commit/fae440550a8c011931629e66ee51d3449e196522))
## [0.1.317](https://github.com/kevinch3/NicotinD/compare/v0.1.316...v0.1.317) (2026-08-06)

### Bug Fixes

* **api,web:** hold-for-review hardening — bootstrap exemption, admin strand warning, hint wording ([#419](https://github.com/kevinch3/NicotinD/issues/419)) ([e0aa347](https://github.com/kevinch3/NicotinD/commit/e0aa3478942255f038301b3c43a0d88cb6ac64ed)), references [#417](https://github.com/kevinch3/NicotinD/issues/417) [#418](https://github.com/kevinch3/NicotinD/issues/418) [#417](https://github.com/kevinch3/NicotinD/issues/417) [#417](https://github.com/kevinch3/NicotinD/issues/417) [#417](https://github.com/kevinch3/NicotinD/issues/417)
## [0.1.316](https://github.com/kevinch3/NicotinD/compare/v0.1.315...v0.1.316) (2026-08-06)

### Features

* **downloads:** download inbox triage — hold-for-review + multi-source metadata fix ([#412](https://github.com/kevinch3/NicotinD/issues/412)) ([2a7452f](https://github.com/kevinch3/NicotinD/commit/2a7452fecbce06d488ff3c1d54b8acec69b1b0e3)), closes [#411](https://github.com/kevinch3/NicotinD/issues/411), references [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411) [#411](https://github.com/kevinch3/NicotinD/issues/411)
## [0.1.315](https://github.com/kevinch3/NicotinD/compare/v0.1.314...v0.1.315) (2026-08-05)

### Features

* **library:** actionable fragmentation report (refs [#314](https://github.com/kevinch3/NicotinD/issues/314)) ([#410](https://github.com/kevinch3/NicotinD/issues/410)) ([6ffaf9b](https://github.com/kevinch3/NicotinD/commit/6ffaf9b68c40153179beaceccadfe0a87546c51b))
## [0.1.314](https://github.com/kevinch3/NicotinD/compare/v0.1.313...v0.1.314) (2026-08-04)
## [0.1.313](https://github.com/kevinch3/NicotinD/compare/v0.1.312...v0.1.313) (2026-08-04)
## [0.1.312](https://github.com/kevinch3/NicotinD/compare/v0.1.311...v0.1.312) (2026-08-04)

### Features

* **web:** tv queue overlay from the now playing next-up chip (refs [#399](https://github.com/kevinch3/NicotinD/issues/399)) ([#407](https://github.com/kevinch3/NicotinD/issues/407)) ([d76f0c8](https://github.com/kevinch3/NicotinD/commit/d76f0c818d9ebe18992f1cf215e36eb89ae14141)), closes [#389](https://github.com/kevinch3/NicotinD/issues/389), references [#398](https://github.com/kevinch3/NicotinD/issues/398)
## [0.1.311](https://github.com/kevinch3/NicotinD/compare/v0.1.310...v0.1.311) (2026-08-04)
## [0.1.310](https://github.com/kevinch3/NicotinD/compare/v0.1.309...v0.1.310) (2026-08-04)

### Bug Fixes

* **ios:** allow plain-http lan servers via an ats exception (refs [#397](https://github.com/kevinch3/NicotinD/issues/397)) ([#405](https://github.com/kevinch3/NicotinD/issues/405)) ([950d9cf](https://github.com/kevinch3/NicotinD/commit/950d9cf0da91abbf224b123d8ab41c09675e52d8))
## [0.1.309](https://github.com/kevinch3/NicotinD/compare/v0.1.308...v0.1.309) (2026-08-04)

### Features

* **web:** d-pad tail — karaoke overlay, admin duplicates, streaming rows (refs [#396](https://github.com/kevinch3/NicotinD/issues/396)) ([#404](https://github.com/kevinch3/NicotinD/issues/404)) ([f0a3ec1](https://github.com/kevinch3/NicotinD/commit/f0a3ec12ff6277c39ef40129a3eb5f9322f0a6ee)), references [#389](https://github.com/kevinch3/NicotinD/issues/389)
## [0.1.308](https://github.com/kevinch3/NicotinD/compare/v0.1.307...v0.1.308) (2026-08-04)
## [0.1.307](https://github.com/kevinch3/NicotinD/compare/v0.1.306...v0.1.307) (2026-08-04)

### Features

* **mobile:** google tv launcher channel row of newest albums (refs [#395](https://github.com/kevinch3/NicotinD/issues/395)) ([#402](https://github.com/kevinch3/NicotinD/issues/402)) ([86a4146](https://github.com/kevinch3/NicotinD/commit/86a414673394c12ae57b135c7de1de1f59493b36))
* **mobile:** self-update the sideloaded apk from github releases ([#403](https://github.com/kevinch3/NicotinD/issues/403)) ([80d222b](https://github.com/kevinch3/NicotinD/commit/80d222b31af3d741038d955ea637060d39c999a5))
## [0.1.306](https://github.com/kevinch3/NicotinD/compare/v0.1.305...v0.1.306) (2026-08-04)

### Bug Fixes

* **web:** tv polish — albums sort i18n leak + tv device name default ([#401](https://github.com/kevinch3/NicotinD/issues/401)) ([6b9f90d](https://github.com/kevinch3/NicotinD/commit/6b9f90d1a7cacce1d2d081c9fa49b8222d715fe4)), references [#391](https://github.com/kevinch3/NicotinD/issues/391) [#393](https://github.com/kevinch3/NicotinD/issues/393)
## [0.1.305](https://github.com/kevinch3/NicotinD/compare/v0.1.304...v0.1.305) (2026-08-04)

### Bug Fixes

* **web:** heal offline mode on any successful api response ([#372](https://github.com/kevinch3/NicotinD/issues/372)) ([3f73d6e](https://github.com/kevinch3/NicotinD/commit/3f73d6e67f4a6024a68abb6a937253f834ef880d))
## [0.1.304](https://github.com/kevinch3/NicotinD/compare/v0.1.303...v0.1.304) (2026-08-04)

### Features

* **api:** approve-from-phone login requests ([b785e6b](https://github.com/kevinch3/NicotinD/commit/b785e6b1041886910794f9a2b7ed23552b4dcbf0))
* **ci:** ship a TV-flagged NicotinD-TV APK from the release workflow ([#387](https://github.com/kevinch3/NicotinD/issues/387)) ([22a1ccb](https://github.com/kevinch3/NicotinD/commit/22a1ccb76484e057397621ecb8d256cba74b2ea1))
* **mobile:** hardware back closes overlays, then navigates, then exits ([#394](https://github.com/kevinch3/NicotinD/issues/394)) ([89ab128](https://github.com/kevinch3/NicotinD/commit/89ab12894ae104ffe35977639668af824e783fd2))
* **mobile:** tv banner wordmark + optional camera feature ([c5d6c29](https://github.com/kevinch3/NicotinD/commit/c5d6c29b363a914eec16b9590ed6f3bd3d48a793)), references [#388](https://github.com/kevinch3/NicotinD/issues/388)
* **mobile:** tv play next channel + assistant play-from-search plugin ([711adb6](https://github.com/kevinch3/NicotinD/commit/711adb639f349e78eded80e17ccb99ee5ae78327))
* **web:** d-pad find-a-song flow — library tabs, album actions, track rows, menus (refs [#389](https://github.com/kevinch3/NicotinD/issues/389)) ([18a898e](https://github.com/kevinch3/NicotinD/commit/18a898eb5ece00e1ff016eb26d3a222a14d15bf1))
* **web:** dedicated TV player for Now Playing ([#387](https://github.com/kevinch3/NicotinD/issues/387)) ([87c5248](https://github.com/kevinch3/NicotinD/commit/87c5248e13ca156dd1b1e9524104fda3c608a7ae)), references [#372](https://github.com/kevinch3/NicotinD/issues/372) [#393](https://github.com/kevinch3/NicotinD/issues/393) [#394](https://github.com/kevinch3/NicotinD/issues/394)
* **web:** inset TV builds into the overscan safe area ([f4b72f5](https://github.com/kevinch3/NicotinD/commit/f4b72f52c88575d2705ede512c6ac6822bcea6ed)), references [#387](https://github.com/kevinch3/NicotinD/issues/387)
* **web:** tv nav groups mix direct items with child groups (refs [#389](https://github.com/kevinch3/NicotinD/issues/389)) ([4fc0de0](https://github.com/kevinch3/NicotinD/commit/4fc0de065522a89e803aebd4bbfe30389e548f9d))
* **web:** tv now playing — radio, close, and track info reachable by d-pad (refs [#389](https://github.com/kevinch3/NicotinD/issues/389)) ([b9f42f5](https://github.com/kevinch3/NicotinD/commit/b9f42f5144bf6baf3e169154e76653e9d2652276))
* **web:** tv overscan calibration presets in settings ([6b30965](https://github.com/kevinch3/NicotinD/commit/6b3096543becd9936415912e756a4b44680a38f3))
* **web:** tv sign-in via phone approval (qr + code) with approve page ([0b25b75](https://github.com/kevinch3/NicotinD/commit/0b25b757b1337af5ac4e15cd796a532d915111ca))

### Bug Fixes

* **docker:** copy the capacitor-tv-channels manifest for the frozen-lockfile install ([8b7957b](https://github.com/kevinch3/NicotinD/commit/8b7957b32cdf12a5f797f7d9c3fb04b8d15e58e2))
* **mobile:** allow cleartext http + mixed content for self-hosted lan servers (refs [#390](https://github.com/kevinch3/NicotinD/issues/390)) ([d5dce6e](https://github.com/kevinch3/NicotinD/commit/d5dce6e78840fddaa5438d8755f5253d1011cb07))
* **mobile:** list the app on the Android TV launcher ([#388](https://github.com/kevinch3/NicotinD/issues/388)) ([c09e2de](https://github.com/kevinch3/NicotinD/commit/c09e2de0349661255d2c1a8b580f283d2bfa225f))
* **web:** don't hijack ArrowLeft/Right for seek on TV builds ([#387](https://github.com/kevinch3/NicotinD/issues/387)) ([513960c](https://github.com/kevinch3/NicotinD/commit/513960c71b643d531d5032f9f30d2b0bcd7ab181))
## [0.1.303](https://github.com/kevinch3/NicotinD/compare/v0.1.302...v0.1.303) (2026-08-03)

### Bug Fixes

* **web:** admin on page-shell max-w-3xl; strip legacy card-in-card panels (refs [#384](https://github.com/kevinch3/NicotinD/issues/384)) ([9dd19e5](https://github.com/kevinch3/NicotinD/commit/9dd19e50213165937034cb4916529fcf116b64f1))
* **web:** final-review polish — slskd heading alignment + idiom docs/guard notes (refs [#384](https://github.com/kevinch3/NicotinD/issues/384)) ([d2a5953](https://github.com/kevinch3/NicotinD/commit/d2a595388b201001ff24949093c105a46d4d26ad))
* **web:** page-shell idiom utilities + browse-tier wrappers (refs [#384](https://github.com/kevinch3/NicotinD/issues/384)) ([7256c60](https://github.com/kevinch3/NicotinD/commit/7256c60d1f882a86259ddcdba63f91a75dc98a21))
* **web:** radio-landing, playlist-detail, share-view on page-shell (refs [#384](https://github.com/kevinch3/NicotinD/issues/384)) ([cb03be4](https://github.com/kevinch3/NicotinD/commit/cb03be47509bdb7c508da39cc97add890af95581))
* **web:** settings family on page-shell max-w-2xl + page-title/section-title (refs [#384](https://github.com/kevinch3/NicotinD/issues/384)) ([3085e31](https://github.com/kevinch3/NicotinD/commit/3085e31ca000576652ca42d37e3e7590855addf2))
## [0.1.302](https://github.com/kevinch3/NicotinD/compare/v0.1.301...v0.1.302) (2026-08-03)

### Features

* **web:** add PullToRefreshService handler stack ([1f9d8ed](https://github.com/kevinch3/NicotinD/commit/1f9d8edec219b7afe405e77ef1bee85bcf10308b))
* **web:** isCoarsePointer platform helper ([2a40a63](https://github.com/kevinch3/NicotinD/commit/2a40a630c41c566d3c7d76c7820c67e7730bd0ed))
* **web:** layout-hosted pull-to-refresh gesture + indicator ([b713aa9](https://github.com/kevinch3/NicotinD/commit/b713aa9bc36d8e8713c9aeddb2fd1460fc8ba1ee))
* **web:** pointercancel support in createPointerDrag ([1c2ee5d](https://github.com/kevinch3/NicotinD/commit/1c2ee5db20f49d33a89d1eebde53fdf4f69ceddb))
* **web:** pull-to-refresh gesture factory ([f7ee3c8](https://github.com/kevinch3/NicotinD/commit/f7ee3c863e04079d3b40ec1ef5a3d1ec7492021b))
* **web:** pull-to-refresh on detail pages ([10d6f5d](https://github.com/kevinch3/NicotinD/commit/10d6f5df71e545f5bb2b88bee0a6909b2f667996))
* **web:** pull-to-refresh on the acquire page ([1febb20](https://github.com/kevinch3/NicotinD/commit/1febb204f99d54d49d6648102ff78d51ddf79a7d))
* **web:** pull-to-refresh on the downloads feed ([372f49f](https://github.com/kevinch3/NicotinD/commit/372f49fb8ef668fb088afbe125d344b62823747e))
* **web:** pull-to-refresh on the library tabs ([0cbafc2](https://github.com/kevinch3/NicotinD/commit/0cbafc25786435082dc06052b8ef3aa0fddd5a1b))

### Bug Fixes

* **web:** guard synchronous onRefresh throw in pull-to-refresh commit ([7754ba6](https://github.com/kevinch3/NicotinD/commit/7754ba6b12a3bfd0e7436b4ca054d060b9aa5883))
* **web:** opt album-picker overlay out of pull-to-refresh ([f15114e](https://github.com/kevinch3/NicotinD/commit/f15114ebd63c1883d3c1504649cbfa23aa908735))
* **web:** opt nested scrollers out of pull-to-refresh ([ad16abc](https://github.com/kevinch3/NicotinD/commit/ad16abce462694feaa79ff24dfece81fdf6a0361))
## [0.1.301](https://github.com/kevinch3/NicotinD/compare/v0.1.300...v0.1.301) (2026-08-03)

### Features

* **web:** collapse Devices and Agent tokens sections into settings-group cards ([8dcb9cd](https://github.com/kevinch3/NicotinD/commit/8dcb9cd843a30399bc737bffb05b4763d76a844f))
* **web:** collapse Extensions kind sections + plugin cards into settings-group cards ([e5bb614](https://github.com/kevinch3/NicotinD/commit/e5bb6143b595c5b4556375a5e8f15907e88829f0))
* **web:** collapse the Settings page groups into settings-group cards ([b3f2f50](https://github.com/kevinch3/NicotinD/commit/b3f2f50c6ab4353cb81556a4aa9900876c5aa113))
* **web:** generalize admin groups into collapsible settings-group cards ([e96e529](https://github.com/kevinch3/NicotinD/commit/e96e52933ca7ec1742db5252fa59b1e78b51110f))

### Bug Fixes

* **web:** collapse the Link device group by default, no exception ([9046c84](https://github.com/kevinch3/NicotinD/commit/9046c843d87239dc57cae813196e8b7a1c907a5d))
* **web:** match the house redirect shape for the slskd route ([0ea0c6e](https://github.com/kevinch3/NicotinD/commit/0ea0c6e3f1f5c1c10a1038f8533d3b35fc206200))
## [0.1.300](https://github.com/kevinch3/NicotinD/compare/v0.1.299...v0.1.300) (2026-08-03)

### Features

* **web:** add Spotify-like desktop side panel to Now Playing at lg ([5a48be4](https://github.com/kevinch3/NicotinD/commit/5a48be43e61c0be4760d357bdff73902e73aa8d5))

### Bug Fixes

* **web:** bound variable-height modal panels above the bottom chrome ([cea5888](https://github.com/kevinch3/NicotinD/commit/cea5888a9330dc4d026c4db1d6a5166d2576ffb9))
* **web:** hoist Now Playing resize handle so it works on the Lyrics tab ([57ec71c](https://github.com/kevinch3/NicotinD/commit/57ec71c45fda32cff397868ac5a8df6d0cc4842b))
## [0.1.299](https://github.com/kevinch3/NicotinD/compare/v0.1.298...v0.1.299) (2026-08-02)

### Features

* **web:** add mic icon for the Now Playing lyrics tab ([fa3324b](https://github.com/kevinch3/NicotinD/commit/fa3324bfe5d635a9667d8b136a60561166ffdcad))
* **web:** add now-playing-panel-tabs (queue/lyrics tab switcher with badge, dot, D-pad) ([65e349a](https://github.com/kevinch3/NicotinD/commit/65e349af02d319cff7879a5739fec7e1cc26b751))
* **web:** add persisted activePanel signal to now-playing, replacing lyrics toggle ([428866f](https://github.com/kevinch3/NicotinD/commit/428866f0b7ccf90831e132aa73cc42b21f893249))

### Bug Fixes

* **web:** give extracted Now Playing/mini-player children display:contents ([4c575bf](https://github.com/kevinch3/NicotinD/commit/4c575bf3da08ec2527ddc094ce9ad3bbfa8b1c43))
* **web:** register theme-secondary/theme-surface/theme-muted as Tailwind colors ([4f6eb20](https://github.com/kevinch3/NicotinD/commit/4f6eb204c46199b6423e830dab3e795d6fff944b))
* **web:** restore karaoke-fullscreen browse-mode auto-scroll, drop dead formatTime ([4e0c978](https://github.com/kevinch3/NicotinD/commit/4e0c978c853d959ba056554ad981eceeba80bb6b)), references [#lyricsScroll](https://github.com/kevinch3/NicotinD/issues/lyricsScroll)
* **web:** seed lyricsOpen from restored activePanel + fix stale hasLyrics dot ([7559456](https://github.com/kevinch3/NicotinD/commit/7559456678932bcde5ffe39910521bca3eec592d))
* **web:** translate the queue panel's hardcoded "N tracks" label ([a1b8ed5](https://github.com/kevinch3/NicotinD/commit/a1b8ed56fe4f9082f412027eb240b453e80b4417))
## [0.1.298](https://github.com/kevinch3/NicotinD/compare/v0.1.297...v0.1.298) (2026-08-02)

### Features

* **web:** add activity, wrench, and database icon glyphs for Admin groups ([e743f42](https://github.com/kevinch3/NicotinD/commit/e743f42e8448ad410a3848873ad7d3673420de50))
* **web:** add collapsible AdminGroupComponent with per-device persistence ([62e540e](https://github.com/kevinch3/NicotinD/commit/62e540e7734d2b3740a356605cc78c04d5f97414))
* **web:** add i18n keys for the regrouped Admin panel ([63562ab](https://github.com/kevinch3/NicotinD/commit/63562ab3772ccd0cbd81e84ed378db47ca9239b0))
* **web:** regroup Admin panel into 8 collapsible icon-headed groups ([bdcde00](https://github.com/kevinch3/NicotinD/commit/bdcde00c1754d8bbf6e5d2e1ff5d8ded9738768d))

### Bug Fixes

* **e2e:** expand User Management admin group before locating user row ([24a764f](https://github.com/kevinch3/NicotinD/commit/24a764f15660fb749c98c0f39567d3e081c925db))
* **web:** restore Admin page heading and un-trap the error banner ([e593bb7](https://github.com/kevinch3/NicotinD/commit/e593bb782265fb29b1b5adde41547b8d0a02e47a))
## [0.1.297](https://github.com/kevinch3/NicotinD/compare/v0.1.296...v0.1.297) (2026-08-02)

### Features

* **web:** add icon headers to Extensions groups, hide empty Connectivity section ([b3e9e8e](https://github.com/kevinch3/NicotinD/commit/b3e9e8ef6d30814072cad64e00adf405aec42e81))
* **web:** add pluginStatus() unified status derivation ([40d622b](https://github.com/kevinch3/NicotinD/commit/40d622bbc6f40e2592d2a148823ac2d0027a3a4d))
* **web:** add wifi icon glyph for the Extensions Connectivity header ([e12bf82](https://github.com/kevinch3/NicotinD/commit/e12bf82f1d04f6b3e256fd620e25cde97575c993))
* **web:** replace two plugin-card badges with one unified status pill ([4e1f237](https://github.com/kevinch3/NicotinD/commit/4e1f237c10f9701ac9d2a4d4231d21987cee2e5e))

### Bug Fixes

* **web:** plugin status pill no longer mislabels working plugins as needs-config ([fced927](https://github.com/kevinch3/NicotinD/commit/fced9272b322e3b4eca8894697b639b6f4cc876f))
## [0.1.296](https://github.com/kevinch3/NicotinD/compare/v0.1.295...v0.1.296) (2026-08-02)

### Bug Fixes

* **web:** reserve bottom-chrome space in full-screen modal backdrops ([cc6b91e](https://github.com/kevinch3/NicotinD/commit/cc6b91eaf648b921ce179674250116ccbd9386d0)), closes [#367](https://github.com/kevinch3/NicotinD/issues/367)
## [0.1.295](https://github.com/kevinch3/NicotinD/compare/v0.1.294...v0.1.295) (2026-08-02)

### Features

* **web:** add i18n keys for regrouped Settings page ([b13478e](https://github.com/kevinch3/NicotinD/commit/b13478e7f39a367bdb91a471b3867b9e1961ff51))
* **web:** add settings-header and device-type icon glyphs ([5fd7cc4](https://github.com/kevinch3/NicotinD/commit/5fd7cc4a45d489ce8761842b70a83c6ab635ce72))
* **web:** add shared SettingsGroupHeaderComponent ([1c4b34d](https://github.com/kevinch3/NicotinD/commit/1c4b34d0b907d22ab341a9bf5a2e5e47064df3a7))
* **web:** regroup Settings page into 4 cards with uniform icon headers ([b782e0b](https://github.com/kevinch3/NicotinD/commit/b782e0b90e0d811170fe4139f552de12a8c03fc7))

### Bug Fixes

* **web:** register theme-accent as a Tailwind color + cover Advanced-card gate ([815a47f](https://github.com/kevinch3/NicotinD/commit/815a47f01c4a6f04054b09e4a1e2423b5f365235))
## [0.1.294](https://github.com/kevinch3/NicotinD/compare/v0.1.293...v0.1.294) (2026-08-01)

### Bug Fixes

* **web:** fix TV nav perf/desync, ARIA grid conformance, queue remove reachability ([08776cf](https://github.com/kevinch3/NicotinD/commit/08776cf9ff98c74e11b6e8d1a40290e5b8701080)), closes [#357](https://github.com/kevinch3/NicotinD/issues/357) [#358](https://github.com/kevinch3/NicotinD/issues/358) [#359](https://github.com/kevinch3/NicotinD/issues/359) [#356](https://github.com/kevinch3/NicotinD/issues/356), references [#351](https://github.com/kevinch3/NicotinD/issues/351)
* **web:** stop changelog.json regeneration from dirtying the working tree ([927688b](https://github.com/kevinch3/NicotinD/commit/927688b718eae6c4b0024e9bf21f810110308192))
## [0.1.293](https://github.com/kevinch3/NicotinD/compare/v0.1.292...v0.1.293) (2026-08-01)

### Bug Fixes

* **web:** stop changelog.json regeneration from dirtying the working tree ([4e4c9e8](https://github.com/kevinch3/NicotinD/commit/4e4c9e81356ae34a40d4150832ea32d542f781ae))
## [0.1.292](https://github.com/kevinch3/NicotinD/compare/v0.1.291...v0.1.292) (2026-08-01)

### Features

* **e2e:** add a one-command README screenshot refresh ([1ee501f](https://github.com/kevinch3/NicotinD/commit/1ee501f66953229bd455aecc867109174f3e56cc))

### Bug Fixes

* **e2e:** bypass the landing gate in the screenshot harness config ([e7fa465](https://github.com/kevinch3/NicotinD/commit/e7fa465f138b5ff0e75ed11ef96af6a5bbbc65e9)), references [#352](https://github.com/kevinch3/NicotinD/issues/352)
* **e2e:** disambiguate the "Track info" locator in the mobile screenshot flow ([22d4dd2](https://github.com/kevinch3/NicotinD/commit/22d4dd261e1688458f806c8ca659e4b925db54a1)), references [#353](https://github.com/kevinch3/NicotinD/issues/353)
* **e2e:** report spawn errors and skip byte-identical copies in screens:readme ([d240607](https://github.com/kevinch3/NicotinD/commit/d2406074591f447087ceb94358125fb8ebb4eaf3)), references [#354](https://github.com/kevinch3/NicotinD/issues/354)
* **e2e:** use viewport screenshots for README shots, closes duplicate player bar glitch ([0c71325](https://github.com/kevinch3/NicotinD/commit/0c7132554af6f67b91943f0b6eaf68a58d9373cc)), closes [#354](https://github.com/kevinch3/NicotinD/issues/354), references [#354](https://github.com/kevinch3/NicotinD/issues/354)
## [0.1.291](https://github.com/kevinch3/NicotinD/compare/v0.1.290...v0.1.291) (2026-08-01)

### Features

* **web:** add karaoke fullscreen browse-mode state and seek-to-line ([072fa05](https://github.com/kevinch3/NicotinD/commit/072fa059a2ee5b52990348f548287625a450bc54))
* **web:** animate the fullscreen karaoke line change with a slide+crossfade ([aec187d](https://github.com/kevinch3/NicotinD/commit/aec187d79e8a72e628693f3a512a981a721150d0))
* **web:** split fullscreen karaoke into 2-line auto-follow + browse-to-seek views ([bc6b67c](https://github.com/kevinch3/NicotinD/commit/bc6b67c8ed998223a6b9ec1390c8c5c3e0e24704))

### Bug Fixes

* **web:** clean up karaoke browse-idle timer on destroy, test ArrowUp ([7f28b59](https://github.com/kevinch3/NicotinD/commit/7f28b599259eea92fcc1efe7bbfaa6634b10abbb))
* **web:** keyboard/TV-remote entry into karaoke browse mode, fix doc accuracy nits ([863fa2e](https://github.com/kevinch3/NicotinD/commit/863fa2e75b98d1d429ea642d8a00767541c246a4))
* **web:** type getLyrics test stub to accept a populated LyricsDto ([9bd1db9](https://github.com/kevinch3/NicotinD/commit/9bd1db9883fbf8ffdb373cedfb30df1e09e7af2f))
## [0.1.290](https://github.com/kevinch3/NicotinD/compare/v0.1.289...v0.1.290) (2026-08-01)
## [0.1.289](https://github.com/kevinch3/NicotinD/compare/v0.1.288...v0.1.289) (2026-08-01)

### Features

* **mobile:** add Android TV touchscreen manifest fix and a tv build flag ([ce815a0](https://github.com/kevinch3/NicotinD/commit/ce815a054ac420c68a8fc7e7c8a1ed1aab8d1b15))
* **web:** add / shortcut to navigate to the Acquire page ([ea6cb2d](https://github.com/kevinch3/NicotinD/commit/ea6cb2df9597ed52a17d184ab4c9cc1fefd73cc7))
* **web:** add app-wide focus-visible ring, apply D-pad nav to the Now Playing queue ([df5f010](https://github.com/kevinch3/NicotinD/commit/df5f01038f4b85624c5c8b757559e9aae06cd43f))
* **web:** add ArrowLeft/ArrowRight seek shortcut, deferring to D-pad nav groups ([2da4ebf](https://github.com/kevinch3/NicotinD/commit/2da4ebf1e3a039cd9ceb8af0e45f9dff15e3ae8a))
* **web:** add global Space/K play-pause shortcut, D-pad nav on transport controls ([687dccd](https://github.com/kevinch3/NicotinD/commit/687dccd6d28fd2883b00fdf78ceba16a9207b669))
* **web:** add grid-axis D-pad navigation to TvNavGroupDirective ([154e980](https://github.com/kevinch3/NicotinD/commit/154e98056b01d3a0679b4e4e32238929b4cf8b51))
* **web:** add J/L/M/N keyboard shortcuts (prev/next/mute/now-playing) ([d04365d](https://github.com/kevinch3/NicotinD/commit/d04365d87313509190de312d3ee8333f7b1dcd44))
* **web:** add roving-tabindex D-pad navigation directive pair ([6e17310](https://github.com/kevinch3/NicotinD/commit/6e17310dce1640fdca3193843ab39bc939accff3))
* **web:** apply D-pad nav to Admin services grid, log buttons, processing tasks ([2631934](https://github.com/kevinch3/NicotinD/commit/2631934755794fd2cbfc433bd23bb42530cffa48))
* **web:** apply D-pad nav to Admin user-management action buttons ([6cb19f8](https://github.com/kevinch3/NicotinD/commit/6cb19f8dba6616b7774d3d68aa9f24955b24f845))
* **web:** apply D-pad nav to Extensions page plugin cards, excluding config inputs ([4d035b0](https://github.com/kevinch3/NicotinD/commit/4d035b0d0778c32d03138d1a4728c078c41e97f0))
* **web:** apply D-pad nav to Search catalog grid/chips and hunt candidate list ([1322899](https://github.com/kevinch3/NicotinD/commit/1322899d3f9641192616652a3d32fae82272d47d))
* **web:** apply D-pad nav to Settings page grids and action lists ([2d84e3c](https://github.com/kevinch3/NicotinD/commit/2d84e3c3685c87ca2d89a570eb036846465d8064))
* **web:** apply D-pad nav to the devices and agent-tokens revoke lists ([835273f](https://github.com/kevinch3/NicotinD/commit/835273fe7073ec10d0336b328966bf480f580b85))
* **web:** apply grid/vertical D-pad nav to Library and artist-detail card grids ([64843e4](https://github.com/kevinch3/NicotinD/commit/64843e4f8720809ef96d62e052649590cedcaa68))
* **web:** d-pad nav for every track row song list (5 pages, 1 shared fix) ([e6724d8](https://github.com/kevinch3/NicotinD/commit/e6724d8a05098c149e9b64f7abeca62e69a49c76))
* **web:** default remote-control opt-in on for TV builds ([a2568b9](https://github.com/kevinch3/NicotinD/commit/a2568b95a7bf0ea25c685daf003eafbc8b71c260))

### Bug Fixes

* **web:** correct the Admin processing axis and Settings' overwritten role ([5233343](https://github.com/kevinch3/NicotinD/commit/523334378b07129432a29257f2cfc699431fcb16))
* **web:** extract the plugin card into a component so D-pad nav reaches it ([06921b6](https://github.com/kevinch3/NicotinD/commit/06921b6f7a872b0bc428f5387dfb3358b11ba1f6))
* **web:** fix TV nav a11y/cascade bugs from Phase 2 final review ([4c5fca2](https://github.com/kevinch3/NicotinD/commit/4c5fca247b0469e7db5fa383f7409144bcb2df14))
* **web:** guard global shortcuts against modifier chords and focused selects ([962d42a](https://github.com/kevinch3/NicotinD/commit/962d42a4e2c14f2dadace150133941cbd313c1ac))
* **web:** invalidate the TV nav item cache on a pure reorder ([377e723](https://github.com/kevinch3/NicotinD/commit/377e723fbe7fea961cb0a3395003f17ac0ca3e05))
* **web:** preventDefault a recognized D-pad key even at a group boundary ([35117aa](https://github.com/kevinch3/NicotinD/commit/35117aa2b67477a4b3589942246fcaae7c6f9039))
* **web:** register TV nav items via DI, not @ContentChildren ([28a48ff](https://github.com/kevinch3/NicotinD/commit/28a48ff03d42a303ae56772c73eeabe75b4b8663))
* **web:** tidy up discarded subscription, inline activeIndex clamp, add missing K+input test ([a845ea4](https://github.com/kevinch3/NicotinD/commit/a845ea432ff7897dc6774ca7b714a42ecf0a1a53))
* **web:** type the queue test stub so typecheck:spec passes ([41dd6dd](https://github.com/kevinch3/NicotinD/commit/41dd6dd99685fbeb926f8d3ac977ca9eae072cd6))
* **web:** unify TV-defaulted remote-enabled preference across sites ([9df3b57](https://github.com/kevinch3/NicotinD/commit/9df3b57cace80e25649da4bcb40cc2ee264f7e46))
## [0.1.288](https://github.com/kevinch3/NicotinD/compare/v0.1.287...v0.1.288) (2026-07-31)

### Features

* **mcp:** merge_artist destructive tool ([5bdfc4c](https://github.com/kevinch3/NicotinD/commit/5bdfc4ca510412d79c2f56854c50b2ce5c7a5094)), closes [#339](https://github.com/kevinch3/NicotinD/issues/339), references [#232](https://github.com/kevinch3/NicotinD/issues/232)
## [0.1.287](https://github.com/kevinch3/NicotinD/compare/v0.1.286...v0.1.287) (2026-07-31)
## [0.1.286](https://github.com/kevinch3/NicotinD/compare/v0.1.285...v0.1.286) (2026-07-31)
## [0.1.285](https://github.com/kevinch3/NicotinD/compare/v0.1.284...v0.1.285) (2026-07-31)
## [0.1.284](https://github.com/kevinch3/NicotinD/compare/v0.1.283...v0.1.284) (2026-07-31)

### Bug Fixes

* **analysis:** /health healthcheck polling defeats idle-release ([fac87c6](https://github.com/kevinch3/NicotinD/commit/fac87c631974b3f97739874c57a0799436c37a02)), closes [#344](https://github.com/kevinch3/NicotinD/issues/344)
* **library:** record an audit log entry on single-song delete ([200c50a](https://github.com/kevinch3/NicotinD/commit/200c50aeeaee6cd0131ad9e7ea1de02c04a89cdd)), closes [#336](https://github.com/kevinch3/NicotinD/issues/336), references [#232](https://github.com/kevinch3/NicotinD/issues/232)
## [0.1.283](https://github.com/kevinch3/NicotinD/compare/v0.1.282...v0.1.283) (2026-07-31)

### Features

* **i18n:** translate player/now-playing/settings + add stable API error codes ([c72b8c0](https://github.com/kevinch3/NicotinD/commit/c72b8c03fccdae976598e5e282722c481005822b)), closes [#236](https://github.com/kevinch3/NicotinD/issues/236), references [#236](https://github.com/kevinch3/NicotinD/issues/236)
* **mcp:** destructive delete tools + agent-token settings UI ([ff4f244](https://github.com/kevinch3/NicotinD/commit/ff4f2447782b4f11d649eafb1840821b4d57cba7)), closes [#232](https://github.com/kevinch3/NicotinD/issues/232)

### Bug Fixes

* **analysis:** idle-release the GPU model registry ([40e4b0d](https://github.com/kevinch3/NicotinD/commit/40e4b0d92c168e6b07430bbb5ae6a2ac82a41728)), references [#224](https://github.com/kevinch3/NicotinD/issues/224)
## [0.1.282](https://github.com/kevinch3/NicotinD/compare/v0.1.281...v0.1.282) (2026-07-30)

### Bug Fixes

* **mobile:** offline mode is detected and switched automatically, both ways ([3874740](https://github.com/kevinch3/NicotinD/commit/38747405cc7ac1815714e05e4d3b4334ac69e273))
## [0.1.281](https://github.com/kevinch3/NicotinD/compare/v0.1.280...v0.1.281) (2026-07-30)

### Features

* **genre:** listener-facing genre distribution strip + primary-only filter ([d7c322a](https://github.com/kevinch3/NicotinD/commit/d7c322a2aee7937eb0d84d3e5f6464986206d3ee)), closes [#222](https://github.com/kevinch3/NicotinD/issues/222), references [#222](https://github.com/kevinch3/NicotinD/issues/222)
## [0.1.280](https://github.com/kevinch3/NicotinD/compare/v0.1.279...v0.1.280) (2026-07-29)

### Features

* **admin:** surface GPU VRAM used/total in the metric pill ([#224](https://github.com/kevinch3/NicotinD/issues/224)) ([17f1492](https://github.com/kevinch3/NicotinD/commit/17f149200d6806c187ae6b08e926d6a4cfa24f11))
* **enrichment:** popularity/hotness signal per song via ListenBrainz ([#220](https://github.com/kevinch3/NicotinD/issues/220)) ([3c85785](https://github.com/kevinch3/NicotinD/commit/3c85785586c5f43a3849f1e339d009e96843f823))
* **i18n:** translate the Acquire page + complete Spanish parity ([#236](https://github.com/kevinch3/NicotinD/issues/236)) ([6f8331e](https://github.com/kevinch3/NicotinD/commit/6f8331ee7e61b445e26202be615b7eb2f94ef995)), references [#227](https://github.com/kevinch3/NicotinD/issues/227)
* **library:** prune orphaned download provenance rows ([#319](https://github.com/kevinch3/NicotinD/issues/319)) ([0215635](https://github.com/kevinch3/NicotinD/commit/0215635064576fd0df208fee07bfcbe8c426c3b6))
* **mcp:** agent tokens + MCP endpoint for refiner-level curation ([#232](https://github.com/kevinch3/NicotinD/issues/232)) ([5cc58db](https://github.com/kevinch3/NicotinD/commit/5cc58db09f4f27a8f0ed63787a076cedab9198b7))
* **web:** rename Search to Acquire, route /search → /acquire ([#227](https://github.com/kevinch3/NicotinD/issues/227)) ([5ff7541](https://github.com/kevinch3/NicotinD/commit/5ff75411c8c3a8b3d5d7d542a36cc86a9db06cda))

### Bug Fixes

* **library:** album genre = most-common primary, not scan order ([#222](https://github.com/kevinch3/NicotinD/issues/222)) ([f1a25fb](https://github.com/kevinch3/NicotinD/commit/f1a25fb8d6f118e833de8b7f1b132ba1ff9daced))

### Performance

* **enrichment:** drop the 0%-yield MusicBrainz licence lookup ([#329](https://github.com/kevinch3/NicotinD/issues/329)) ([fefc0fc](https://github.com/kevinch3/NicotinD/commit/fefc0fc5ea315a46a206fcf531b8b784c6bb0b92))
* **web:** lazy-load the Sentry SDK, keep startup capture ([#285](https://github.com/kevinch3/NicotinD/issues/285)) ([9cef10b](https://github.com/kevinch3/NicotinD/commit/9cef10bcca3566f6249ecacf822305642776a294))
## [0.1.279](https://github.com/kevinch3/NicotinD/compare/v0.1.278...v0.1.279) (2026-07-29)

### Features

* **admin:** expose the acquisition kill-switch as a UI control ([14165cd](https://github.com/kevinch3/NicotinD/commit/14165cd01849e1d326b4ad56058cb5731b2fe0e3)), references [#235](https://github.com/kevinch3/NicotinD/issues/235) [#235](https://github.com/kevinch3/NicotinD/issues/235)
* **admin:** make the acquisition kill-switch runtime-togglable (issue [#235](https://github.com/kevinch3/NicotinD/issues/235)) ([d8cd59f](https://github.com/kevinch3/NicotinD/commit/d8cd59f3ba73eba785a0721dbaf55245689ead79))
* **admin:** show artist-portrait coverage (issue [#250](https://github.com/kevinch3/NicotinD/issues/250) gap 3) ([2feda63](https://github.com/kevinch3/NicotinD/commit/2feda630f3e7751dfa7920320c63c305838a2701)), references [#274](https://github.com/kevinch3/NicotinD/issues/274) [#314](https://github.com/kevinch3/NicotinD/issues/314)
* **deploy:** build the YouTube PO-token provider under our own GHCR ([b6009aa](https://github.com/kevinch3/NicotinD/commit/b6009aa942c00c25eb3352fa82aaceecb9017fab)), closes [#238](https://github.com/kevinch3/NicotinD/issues/238) [#238](https://github.com/kevinch3/NicotinD/issues/238), references [#289](https://github.com/kevinch3/NicotinD/issues/289)
* **library:** add-photo affordance on the Artists grid (issue [#250](https://github.com/kevinch3/NicotinD/issues/250) gap 4) ([6c643cc](https://github.com/kevinch3/NicotinD/commit/6c643cc6b52f33352c715cc68d34319fde03660f)), references [#273](https://github.com/kevinch3/NicotinD/issues/273)

### Bug Fixes

* **library:** make the fragment reporter agree with the curator on track counts ([073950f](https://github.com/kevinch3/NicotinD/commit/073950fcc14c7785102d848f63573fc68bb6d6c7)), references [#301](https://github.com/kevinch3/NicotinD/issues/301) [#315](https://github.com/kevinch3/NicotinD/issues/315) [#315](https://github.com/kevinch3/NicotinD/issues/315) [#314](https://github.com/kevinch3/NicotinD/issues/314) [#314](https://github.com/kevinch3/NicotinD/issues/314)
* **storage:** prune orphaned scan_cache rows, recover stranded provenance ([81113f3](https://github.com/kevinch3/NicotinD/commit/81113f3a8e03e060535322b77ffb5713681263ea)), closes [#313](https://github.com/kevinch3/NicotinD/issues/313), references [#259](https://github.com/kevinch3/NicotinD/issues/259) [#319](https://github.com/kevinch3/NicotinD/issues/319)
* **streaming:** stop re-running a doomed transcode on every play ([64fc4a3](https://github.com/kevinch3/NicotinD/commit/64fc4a30186cf0c3bad77749a74fba21f1bc8ad1)), closes [#317](https://github.com/kevinch3/NicotinD/issues/317)
* **test:** stub the artistImages slice in the review route harness ([2095b9f](https://github.com/kevinch3/NicotinD/commit/2095b9f82afa654e97f71acc514ebf01a8719ab3)), references [#250](https://github.com/kevinch3/NicotinD/issues/250)
## [0.1.278](https://github.com/kevinch3/NicotinD/compare/v0.1.277...v0.1.278) (2026-07-28)

### Bug Fixes

* **library:** don't let a catalog "single" outrank an 18-track folder ([#315](https://github.com/kevinch3/NicotinD/issues/315)) ([30c5a76](https://github.com/kevinch3/NicotinD/commit/30c5a762684cbc751edd7f46cece743177559102)), references [#301](https://github.com/kevinch3/NicotinD/issues/301)
## [0.1.277](https://github.com/kevinch3/NicotinD/compare/v0.1.276...v0.1.277) (2026-07-27)

### Features

* **artists:** on-demand + bulk artist-portrait fill ([#250](https://github.com/kevinch3/NicotinD/issues/250)) ([925646c](https://github.com/kevinch3/NicotinD/commit/925646c6ad0f8ad9a20cb6d13fd934fa138966cc)), references [#281](https://github.com/kevinch3/NicotinD/issues/281)
* **deploy:** streaming-only compose profile + hide Extensions acquisition ([#235](https://github.com/kevinch3/NicotinD/issues/235)) ([559410f](https://github.com/kevinch3/NicotinD/commit/559410f185a0055de8e0b1a579a9bd59c0e1e09a))
* **genre:** before/after view for artist genre reclassification ([#222](https://github.com/kevinch3/NicotinD/issues/222)) ([fa0ffc6](https://github.com/kevinch3/NicotinD/commit/fa0ffc6e326d99c8f3bf881fa852a3a17850cc56)), references [#260](https://github.com/kevinch3/NicotinD/issues/260)
* **i18n:** runtime JSON translation foundation + login surface ([#236](https://github.com/kevinch3/NicotinD/issues/236)) ([634e667](https://github.com/kevinch3/NicotinD/commit/634e6678a992d592336d15cdbbd001651b62a6bc)), references [#256](https://github.com/kevinch3/NicotinD/issues/256)
* **i18n:** translate the app shell — both navs + offline banner ([#236](https://github.com/kevinch3/NicotinD/issues/236)) ([f4a2ea5](https://github.com/kevinch3/NicotinD/commit/f4a2ea5a0ff3e543b1e101aba15b7b0c18f25787)), references [#293](https://github.com/kevinch3/NicotinD/issues/293)
* **i18n:** translate the home page vibe presets + headings ([#236](https://github.com/kevinch3/NicotinD/issues/236)) ([4d654a7](https://github.com/kevinch3/NicotinD/commit/4d654a70e5dc59c387eac7c8fd131785b4df11d2)), references [#295](https://github.com/kevinch3/NicotinD/issues/295)
* **i18n:** translate the library tabs + sort options ([#236](https://github.com/kevinch3/NicotinD/issues/236)) ([d646d12](https://github.com/kevinch3/NicotinD/commit/d646d12f01ea70c1333cf89054cc10d9deabce40)), references [#294](https://github.com/kevinch3/NicotinD/issues/294)
* **processing:** yield the window while the shared GPU is busy ([#224](https://github.com/kevinch3/NicotinD/issues/224)) ([94b2e08](https://github.com/kevinch3/NicotinD/commit/94b2e0847b4923567ffb59e70c286b0a68a0a449))
* **storage:** evict orphaned cover-cache files on a grace period ([#311](https://github.com/kevinch3/NicotinD/issues/311)) ([698b670](https://github.com/kevinch3/NicotinD/commit/698b670f636683ee53c94656e61d979f45a101af)), references [#259](https://github.com/kevinch3/NicotinD/issues/259)

### Bug Fixes

* **acquisition:** rescue organized items whose path differs only by accents ([81a8200](https://github.com/kevinch3/NicotinD/commit/81a8200738917b2dbb97dfce24998b5f9f931336)), references [#262](https://github.com/kevinch3/NicotinD/issues/262)
* **artists:** carry curation across an identity fix ([#305](https://github.com/kevinch3/NicotinD/issues/305)) ([88b12f9](https://github.com/kevinch3/NicotinD/commit/88b12f9df814c889dd2679816888102facaf5403))
* **build:** collapse the duplicate typecheck script from the [#278](https://github.com/kevinch3/NicotinD/issues/278) merge ([07c2731](https://github.com/kevinch3/NicotinD/commit/07c2731fd628fd4f97ca6c44a4140ac0622d28b8))
* **e2e:** build web before the suite so it can't test a stale bundle ([#253](https://github.com/kevinch3/NicotinD/issues/253)) ([40948ca](https://github.com/kevinch3/NicotinD/commit/40948ca63a8ce7e673792ba21a05294937e50cea))
* **playlists:** carry membership across a song-id change on prune ([919d069](https://github.com/kevinch3/NicotinD/commit/919d06984e847a6d09df756ec9aa7c416aacd82d))
* **scripts:** check-fragments never ran in Docker (expandHome returned '') ([e71049d](https://github.com/kevinch3/NicotinD/commit/e71049de2ec0784e094d5c671317dddce750e07d))
## [0.1.276](https://github.com/kevinch3/NicotinD/compare/v0.1.275...v0.1.276) (2026-07-27)

### Features

* **db:** prune orphaned per-song side-table rows on a grace period ([#259](https://github.com/kevinch3/NicotinD/issues/259)) ([16c03ed](https://github.com/kevinch3/NicotinD/commit/16c03ed3b5b3086a4278f3bc925c3b28eb1589a0))
## [0.1.275](https://github.com/kevinch3/NicotinD/compare/v0.1.274...v0.1.275) (2026-07-27)

### Bug Fixes

* **hunt:** rank a whole-discography dump below the album folder ([#271](https://github.com/kevinch3/NicotinD/issues/271)) ([fe420d4](https://github.com/kevinch3/NicotinD/commit/fe420d40bedf845dfa2e89d7bdfa0f0b113bc306)), references [#262](https://github.com/kevinch3/NicotinD/issues/262)
## [0.1.274](https://github.com/kevinch3/NicotinD/compare/v0.1.273...v0.1.274) (2026-07-26)

### Bug Fixes

* **acquisition:** close the six open download/cover bugs ([#258](https://github.com/kevinch3/NicotinD/issues/258) [#261](https://github.com/kevinch3/NicotinD/issues/261) [#262](https://github.com/kevinch3/NicotinD/issues/262) [#263](https://github.com/kevinch3/NicotinD/issues/263) [#264](https://github.com/kevinch3/NicotinD/issues/264) [#265](https://github.com/kevinch3/NicotinD/issues/265)) ([fab2a91](https://github.com/kevinch3/NicotinD/commit/fab2a9101dc20ac1cc261f48d12106ffa46c80b0))
## [0.1.273](https://github.com/kevinch3/NicotinD/compare/v0.1.272...v0.1.273) (2026-07-26)

### Bug Fixes

* **test:** type-check the web specs and repair 30 accumulated type errors ([c65d2ac](https://github.com/kevinch3/NicotinD/commit/c65d2acce0bbabd1708d9be71db5507fd3527429))
## [0.1.272](https://github.com/kevinch3/NicotinD/compare/v0.1.271...v0.1.272) (2026-07-26)

### Bug Fixes

* **player:** bound the false-ended recovery loop + salvage [#243](https://github.com/kevinch3/NicotinD/issues/243)/[#244](https://github.com/kevinch3/NicotinD/issues/244) deltas ([245aa4e](https://github.com/kevinch3/NicotinD/commit/245aa4e47f30b1a75496b586173a600dd1aef670)), references [#221](https://github.com/kevinch3/NicotinD/issues/221) [#224](https://github.com/kevinch3/NicotinD/issues/224) [#233](https://github.com/kevinch3/NicotinD/issues/233) [#234](https://github.com/kevinch3/NicotinD/issues/234) [#233](https://github.com/kevinch3/NicotinD/issues/233) [#224](https://github.com/kevinch3/NicotinD/issues/224)
## [0.1.271](https://github.com/kevinch3/NicotinD/compare/v0.1.270...v0.1.271) (2026-07-26)

### Bug Fixes

* **genre:** let the curator choose whether an artist genre fix appends or replaces ([27d5a85](https://github.com/kevinch3/NicotinD/commit/27d5a8584b5221eea5df7824a243a322452e9dc4)), closes [#260](https://github.com/kevinch3/NicotinD/issues/260)
## [0.1.270](https://github.com/kevinch3/NicotinD/compare/v0.1.269...v0.1.270) (2026-07-26)

### Features

* **admin:** expose the compute throttle + analysis sidecar status ([#224](https://github.com/kevinch3/NicotinD/issues/224)) ([6bea80e](https://github.com/kevinch3/NicotinD/commit/6bea80e7fb92e99d6fa51c4a1cf6572969470eb8))
* **genre:** radar visualization of an artist's genre spread ([#222](https://github.com/kevinch3/NicotinD/issues/222)) ([90e9c1d](https://github.com/kevinch3/NicotinD/commit/90e9c1d02c7d4f216257185c76957e7a87cdd96c))

### Bug Fixes

* **genre-radar:** make slices an optional input, not a required one ([0861995](https://github.com/kevinch3/NicotinD/commit/0861995ada3de60042b7c25b7df8e243a200bab7))
* **test:** mock the genre-distribution fetch in the modal spec ([ff0c69f](https://github.com/kevinch3/NicotinD/commit/ff0c69f8845cdd348e6dd55945ed048a2e82fd0f))
## [0.1.269](https://github.com/kevinch3/NicotinD/compare/v0.1.268...v0.1.269) (2026-07-26)

### Features

* **admin:** portable configuration export/import ([#221](https://github.com/kevinch3/NicotinD/issues/221)) ([eeff5f7](https://github.com/kevinch3/NicotinD/commit/eeff5f7854bb02b0a88544d488480f007492117a))

### Bug Fixes

* **player:** a track click replaces the queue it belongs to ([#233](https://github.com/kevinch3/NicotinD/issues/233)) ([37ab44c](https://github.com/kevinch3/NicotinD/commit/37ab44c64be801f78feadfcdc77716bcc376c4b1))
## [0.1.268](https://github.com/kevinch3/NicotinD/compare/v0.1.267...v0.1.268) (2026-07-26)

### Bug Fixes

* **discography:** name-only Lidarr corroboration, no link regressions ([#212](https://github.com/kevinch3/NicotinD/issues/212)) ([880edeb](https://github.com/kevinch3/NicotinD/commit/880edeb93a6af5e57784f06c88cb33165c9fa1f8)), references [211/#217](https://github.com/kevinch3/NicotinD/issues/217)
* **discography:** refuse to provision uncorroborated Lidarr artists ([#212](https://github.com/kevinch3/NicotinD/issues/212)) ([dbd00a0](https://github.com/kevinch3/NicotinD/commit/dbd00a0dff32cb79625058ac4e480ae107406999)), references [211/#217](https://github.com/kevinch3/NicotinD/issues/217)
## [0.1.267](https://github.com/kevinch3/NicotinD/compare/v0.1.266...v0.1.267) (2026-07-26)

### Bug Fixes

* **player:** close false-ended guard gap for tracks with unknown duration ([8a6c84b](https://github.com/kevinch3/NicotinD/commit/8a6c84b2981060ee09022c4420f95014b5ed4ae6)), references [#234](https://github.com/kevinch3/NicotinD/issues/234)
## [0.1.266](https://github.com/kevinch3/NicotinD/compare/v0.1.265...v0.1.266) (2026-07-26)

### Features

* **library:** like button + liked songs playlist; auto-playlist controls ([eaa7d30](https://github.com/kevinch3/NicotinD/commit/eaa7d30677a22a5939f3a68a6b5db96d53f6297d)), closes [#225](https://github.com/kevinch3/NicotinD/issues/225) [#228](https://github.com/kevinch3/NicotinD/issues/228), references [#225](https://github.com/kevinch3/NicotinD/issues/225) [#228](https://github.com/kevinch3/NicotinD/issues/228)
## [0.1.265](https://github.com/kevinch3/NicotinD/compare/v0.1.264...v0.1.265) (2026-07-26)

### Features

* **acquisition:** kill-switch ([#235](https://github.com/kevinch3/NicotinD/issues/235)), acquisition-only Search ([#227](https://github.com/kevinch3/NicotinD/issues/227)), direct-grab fix ([#223](https://github.com/kevinch3/NicotinD/issues/223)) ([4094cf9](https://github.com/kevinch3/NicotinD/commit/4094cf9d191abb4f5059e4ed83684c881711d033))
## [0.1.264](https://github.com/kevinch3/NicotinD/compare/v0.1.263...v0.1.264) (2026-07-26)

### Features

* **share:** artist shares, logged-in redirect, and post-login return URL ([57f98b8](https://github.com/kevinch3/NicotinD/commit/57f98b8b446451605942ea352cccc7f1cba4b11f))
## [0.1.263](https://github.com/kevinch3/NicotinD/compare/v0.1.262...v0.1.263) (2026-07-26)

### Features

* **db:** generalized library_external_ids cache for non-MB provider ids ([#194](https://github.com/kevinch3/NicotinD/issues/194)) ([9266132](https://github.com/kevinch3/NicotinD/commit/9266132a12e129e519ba1d364a78bdc631476216))
* **genre:** album-scoped Discogs genre enrichment task (closes [#194](https://github.com/kevinch3/NicotinD/issues/194)) ([82517b9](https://github.com/kevinch3/NicotinD/commit/82517b92cbaa443cdee1156ca097ed371b3bae9d)), references [#187](https://github.com/kevinch3/NicotinD/issues/187)
* **genre:** map Discogs top-level vocab before splitGenres ([#194](https://github.com/kevinch3/NicotinD/issues/194)) ([e81039c](https://github.com/kevinch3/NicotinD/commit/e81039cf525449486e6164419552d01a0c1f59d4))

### Bug Fixes

* **discogs:** map top-level genres before returning them ([#194](https://github.com/kevinch3/NicotinD/issues/194)) ([e4c3783](https://github.com/kevinch3/NicotinD/commit/e4c37831b32673ecadc8abf2f0b3be9026674a17))
* **scripts:** measure-discogs-coverage opens nicotind.db not library.db ([bf094d0](https://github.com/kevinch3/NicotinD/commit/bf094d0cff28b8c80e948fa02af7c80c88a93f10)), references [#191](https://github.com/kevinch3/NicotinD/issues/191) [#191](https://github.com/kevinch3/NicotinD/issues/191)
## [0.1.262](https://github.com/kevinch3/NicotinD/compare/v0.1.261...v0.1.262) (2026-07-26)

### Bug Fixes

* **web:** invalidate cached artists/genres lists after library mutations ([7e7e549](https://github.com/kevinch3/NicotinD/commit/7e7e549c1eab66bf2924766eab5059868079d507)), references [#237](https://github.com/kevinch3/NicotinD/issues/237) [#210](https://github.com/kevinch3/NicotinD/issues/210)
## [0.1.261](https://github.com/kevinch3/NicotinD/compare/v0.1.260...v0.1.261) (2026-07-25)

### Features

* **scanner:** segment delimiter-less artist mashes ([#212](https://github.com/kevinch3/NicotinD/issues/212)) ([bf86e2a](https://github.com/kevinch3/NicotinD/commit/bf86e2a3aa9a1187446ca0058418d0fd5e89b7e4)), closes [#217](https://github.com/kevinch3/NicotinD/issues/217) [#216](https://github.com/kevinch3/NicotinD/issues/216), references [211/#217](https://github.com/kevinch3/NicotinD/issues/217) [#220](https://github.com/kevinch3/NicotinD/issues/220)
## [0.1.260](https://github.com/kevinch3/NicotinD/compare/v0.1.259...v0.1.260) (2026-07-25)

### Bug Fixes

* **bio:** handle Discogs [a=Name] refs + [b]/[i] tags in artist bios ([4b4a681](https://github.com/kevinch3/NicotinD/commit/4b4a68180c5702a07e76a5ff281bbcb87ccf3c1c)), references [#213](https://github.com/kevinch3/NicotinD/issues/213) [#213](https://github.com/kevinch3/NicotinD/issues/213)
## [0.1.259](https://github.com/kevinch3/NicotinD/compare/v0.1.258...v0.1.259) (2026-07-25)

### Bug Fixes

* **deploy:** decouple analysis GPU opt-in into docker-compose.gpu.yml overlay ([18a4e84](https://github.com/kevinch3/NicotinD/commit/18a4e848fba00546091505939f71f8e1ebb01fbc))
## [0.1.258](https://github.com/kevinch3/NicotinD/compare/v0.1.257...v0.1.258) (2026-07-25)

### Bug Fixes

* **deploy:** pin bgutil-provider + analysis to runtime: runc ([4944270](https://github.com/kevinch3/NicotinD/commit/494427093d9145ed357c3c3eececb11e63d3b684))
## [0.1.257](https://github.com/kevinch3/NicotinD/compare/v0.1.256...v0.1.257) (2026-07-25)

### Bug Fixes

* **api:** apply integrity check to ingest-time Opus transcode ([51478be](https://github.com/kevinch3/NicotinD/commit/51478be0dd90d517d67ceb7ddce26e873d4bbee6))
* **api:** validate transcode cache integrity ([b15161c](https://github.com/kevinch3/NicotinD/commit/b15161cb59cf5854447fa2fd5ed86e94a820cdc4))
* **web:** defend against premature track-end on transcoded playback ([6e07777](https://github.com/kevinch3/NicotinD/commit/6e07777b5288851c584db2ff616273c2f73af6b3))
## [0.1.256](https://github.com/kevinch3/NicotinD/compare/v0.1.255...v0.1.256) (2026-07-24)

### Bug Fixes

* **library:** widen Lidarr MBID resolution for canonical-name drift (issue [#211](https://github.com/kevinch3/NicotinD/issues/211)) ([bf617ec](https://github.com/kevinch3/NicotinD/commit/bf617eca643ea879d0e7508f97bfc4f81e3c24ed)), references [#1](https://github.com/kevinch3/NicotinD/issues/1)
## [0.1.255](https://github.com/kevinch3/NicotinD/compare/v0.1.254...v0.1.255) (2026-07-24)

### Features

* **web:** artist bio polish — auto-fetch, clean markup, Sources, overflow-based show-more ([a5d350e](https://github.com/kevinch3/NicotinD/commit/a5d350e0e958e02ce72e692636b654da4392f9aa)), closes [#213](https://github.com/kevinch3/NicotinD/issues/213), references [#195](https://github.com/kevinch3/NicotinD/issues/195) [#209](https://github.com/kevinch3/NicotinD/issues/209)
## [0.1.254](https://github.com/kevinch3/NicotinD/compare/v0.1.253...v0.1.254) (2026-07-24)

### Bug Fixes

* **web:** invalidate library reads on artist-genre save/clear ([#210](https://github.com/kevinch3/NicotinD/issues/210)) ([aafb074](https://github.com/kevinch3/NicotinD/commit/aafb0741ce8fa740005a52ec071eb7e2644cbb04)), closes [#209](https://github.com/kevinch3/NicotinD/issues/209)
## [0.1.253](https://github.com/kevinch3/NicotinD/compare/v0.1.252...v0.1.253) (2026-07-24)

### Bug Fixes

* **library:** resolve MBID via Lidarr in interactive artist-info refresh ([a9d0840](https://github.com/kevinch3/NicotinD/commit/a9d084014c8e07cd344d7f38132910b219cf9700))
* **web:** reflect artist rename/merge/split and land on the resulting artist ([2efd2f8](https://github.com/kevinch3/NicotinD/commit/2efd2f8ffefdd3be17dc6176a79d4a6644fabb27))
## [0.1.252](https://github.com/kevinch3/NicotinD/compare/v0.1.251...v0.1.252) (2026-07-24)

### Bug Fixes

* **library:** resolve artist MBIDs via Lidarr fallback for artist-info ([#207](https://github.com/kevinch3/NicotinD/issues/207)) ([994b0ee](https://github.com/kevinch3/NicotinD/commit/994b0eeb77ac98d129b9d8710d493a3f5406c4bd))
## [0.1.251](https://github.com/kevinch3/NicotinD/compare/v0.1.250...v0.1.251) (2026-07-24)

### Features

* **discogs:** add mapArtistInfo pure parser ([3005f1c](https://github.com/kevinch3/NicotinD/commit/3005f1c22a8cf21bdfd2bd5662c0923461b05641))
* **discogs:** wire MBID-first artist resolution via MusicBrainz ([a861735](https://github.com/kevinch3/NicotinD/commit/a86173596788b81a7b900c5c6c7dba5d0cef9a99))
* **discogs:** wire the artist-info capability ([f089737](https://github.com/kevinch3/NicotinD/commit/f089737caef6e55a4d069788186a2e996479f334)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)
* **library:** add artist bio attach + refresh-info + manual-edit routes ([013560a](https://github.com/kevinch3/NicotinD/commit/013560acdad082b229d1d6bbc4e48c134d88283e)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)
* **library:** add artist-info enrichment task ([810cca1](https://github.com/kevinch3/NicotinD/commit/810cca1f3471e5f4b33777ceccfd5b6f4d0cd147)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)
* **library:** add library_artist_meta table + store ([2e1e8e0](https://github.com/kevinch3/NicotinD/commit/2e1e8e001502e94abac5c8d4613abe51e8769c73)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)
* **library:** wire artist-info lookup into the processing scheduler ([cceb0d9](https://github.com/kevinch3/NicotinD/commit/cceb0d9ed0a4126b3d72670eb26425829df4f54a))
* **musicbrainz:** add getArtistDiscogsUrl via artist url-rels ([41b6448](https://github.com/kevinch3/NicotinD/commit/41b6448523114bf96b88f8b281a9a08756d9ab9c)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)
* **plugins:** add artist-info metadata capability contract ([f0db680](https://github.com/kevinch3/NicotinD/commit/f0db68017144003e81f8c491407c687822b76867))
* **web:** add artist-info API service methods + shared type ([7ff55c5](https://github.com/kevinch3/NicotinD/commit/7ff55c5e580ee69362b06178bfd5e54a4033bf5a))
* **web:** show artist bio + links on the artist page ([a7c5a29](https://github.com/kevinch3/NicotinD/commit/a7c5a2959988a1700107be65a0ae8de3f54a0bbe)), references [#195](https://github.com/kevinch3/NicotinD/issues/195)

### Bug Fixes

* **library:** return 502 on transient discogs artist-info failure ([cc3cee2](https://github.com/kevinch3/NicotinD/commit/cc3cee23f8cb448e9410ed66e4f6379acb956d72))
## [0.1.250](https://github.com/kevinch3/NicotinD/compare/v0.1.249...v0.1.250) (2026-07-24)

### Bug Fixes

* **library:** confidence-gate key detection (issue [#187](https://github.com/kevinch3/NicotinD/issues/187) B5) ([b1e60a5](https://github.com/kevinch3/NicotinD/commit/b1e60a5cbf173e3be1c3594fd6e67795bda76bd3))
* **radio:** filter-radio genre-blindness in seedCentroid (issue [#187](https://github.com/kevinch3/NicotinD/issues/187) B4) ([12a46c0](https://github.com/kevinch3/NicotinD/commit/12a46c0910ada1dcb28987cbf67aaa96a6d77be4))
* **radio:** re-measure and raise the genre scoring weight (issue [#187](https://github.com/kevinch3/NicotinD/issues/187) B3) ([7157b2b](https://github.com/kevinch3/NicotinD/commit/7157b2b472a47c9329f598aa8638e9bb5a4fa543)), references [#186](https://github.com/kevinch3/NicotinD/issues/186)
## [0.1.249](https://github.com/kevinch3/NicotinD/compare/v0.1.248...v0.1.249) (2026-07-23)

### Features

* **library:** add genre-audio fallback task (issue [#187](https://github.com/kevinch3/NicotinD/issues/187) A2) ([2b31810](https://github.com/kevinch3/NicotinD/commit/2b31810c0710d769301442b2a133612f11e94be2)), references [#202](https://github.com/kevinch3/NicotinD/issues/202)
## [0.1.248](https://github.com/kevinch3/NicotinD/compare/v0.1.247...v0.1.248) (2026-07-23)

### Features

* **analysis:** add genre_discogs400 classification head ([ada5d16](https://github.com/kevinch3/NicotinD/commit/ada5d16981737c8d13200324cc5bd2201952a756)), references [#187](https://github.com/kevinch3/NicotinD/issues/187)
## [0.1.247](https://github.com/kevinch3/NicotinD/compare/v0.1.246...v0.1.247) (2026-07-23)

### Features

* **playlists:** add song autocomplete + playlist proposals endpoints ([de6b45a](https://github.com/kevinch3/NicotinD/commit/de6b45aaf7a21bac3ec9cc2a9c184fcbda1f7dc8))
* **playlists:** add song picker + suggested-songs list to playlist detail ([b4197e4](https://github.com/kevinch3/NicotinD/commit/b4197e4f6514ec73d253e2428e120df2d9dc3e4e))
* **playlists:** merge playlist list into one + remove generate-from-favorites ([3482782](https://github.com/kevinch3/NicotinD/commit/348278270ee8dd43144d3b3289c1af18815789a8))

### Bug Fixes

* **playlists:** rank autocomplete results before slicing ([49ef6c1](https://github.com/kevinch3/NicotinD/commit/49ef6c168816bf3e5ea86463ce677da982626373))
## [0.1.246](https://github.com/kevinch3/NicotinD/compare/v0.1.245...v0.1.246) (2026-07-23)

### Bug Fixes

* **discogs:** don't fail the whole config save on a blank cacheTtlDays ([4f07a15](https://github.com/kevinch3/NicotinD/commit/4f07a15d05eba583b6b02cc8a09422ffc85b18a9))
* **library:** rescan slskd shares after deleting library files ([bf89744](https://github.com/kevinch3/NicotinD/commit/bf8974479f5a1e701a9a43597f85554efffbc507))
* **spotify:** stop artist-image enrichment from calling Spotify while the plugin is disabled ([00ae98a](https://github.com/kevinch3/NicotinD/commit/00ae98ab355514633ad5159d860f46e830e8c244))
## [0.1.245](https://github.com/kevinch3/NicotinD/compare/v0.1.244...v0.1.245) (2026-07-23)

### Features

* **plugins:** Discogs metadata plugin shell — manifest, client, auth, rate limiting ([2ec9849](https://github.com/kevinch3/NicotinD/commit/2ec9849f8f52365d10f71be2f5d3378b0e1f4fb7)), references [#191](https://github.com/kevinch3/NicotinD/issues/191) [#187](https://github.com/kevinch3/NicotinD/issues/187) [#193](https://github.com/kevinch3/NicotinD/issues/193)
## [0.1.244](https://github.com/kevinch3/NicotinD/compare/v0.1.243...v0.1.244) (2026-07-23)

### Features

* **library:** override-capable genre write path + trusted-metadata genre ([238b742](https://github.com/kevinch3/NicotinD/commit/238b74240414395804fc17992e5fc6aff4f8b5b4)), references [#187](https://github.com/kevinch3/NicotinD/issues/187)

### Bug Fixes

* **plugins:** render metadata extensions in the Extensions UI ([13c920f](https://github.com/kevinch3/NicotinD/commit/13c920f36c81d4da0996bf808831117a2ab3a961)), references [#190](https://github.com/kevinch3/NicotinD/issues/190)
* **plugins:** wire the registry into spotdl so it forwards Spotify credentials ([01049b0](https://github.com/kevinch3/NicotinD/commit/01049b037f9750c3da7aa998ac71ee7a70d9afb8)), references [#190](https://github.com/kevinch3/NicotinD/issues/190)
* **web:** improve mobile nav contrast, sign-in rhythm, and home chip hover ([9dee81f](https://github.com/kevinch3/NicotinD/commit/9dee81f48da8c97959a8791b2ce80cbb47a99e49))
## [0.1.243](https://github.com/kevinch3/NicotinD/compare/v0.1.242...v0.1.243) (2026-07-23)

### Bug Fixes

* **radio:** split mashed genre tags and stop rewarding missing genre ([ecc50b2](https://github.com/kevinch3/NicotinD/commit/ecc50b2a4766102d980de26000478dab9f317708)), references [#184](https://github.com/kevinch3/NicotinD/issues/184) [#185](https://github.com/kevinch3/NicotinD/issues/185)
## [0.1.242](https://github.com/kevinch3/NicotinD/compare/v0.1.241...v0.1.242) (2026-07-22)

### Features

* **radio:** developer diagnostic dump + explainSimilarity breakdown ([72210c0](https://github.com/kevinch3/NicotinD/commit/72210c0b7f8ea35d8e39173ce9553884b5b2ae08))
## [0.1.241](https://github.com/kevinch3/NicotinD/compare/v0.1.240...v0.1.241) (2026-07-22)
## [0.1.240](https://github.com/kevinch3/NicotinD/compare/v0.1.239...v0.1.240) (2026-07-22)

### Features

* **feedback:** capture album-hunt recognition feedback → replayable TDD fixtures ([65d2caf](https://github.com/kevinch3/NicotinD/commit/65d2caf1c6a08ee5684a088a0055b9136519af9c)), references [#1](https://github.com/kevinch3/NicotinD/issues/1)
## [0.1.239](https://github.com/kevinch3/NicotinD/compare/v0.1.238...v0.1.239) (2026-07-22)
## [0.1.238](https://github.com/kevinch3/NicotinD/compare/v0.1.237...v0.1.238) (2026-07-22)

### Features

* **library:** album/compilation licence rollup (entirely-Public-Domain) ([5f20492](https://github.com/kevinch3/NicotinD/commit/5f20492612a8fe3c2f1688d124fd20087359e14d))
* **library:** music licence/rights per track (set, auto-retrieve, filter) ([b0de7e5](https://github.com/kevinch3/NicotinD/commit/b0de7e52158c658d27887445c402b22a24f0725c))
## [0.1.237](https://github.com/kevinch3/NicotinD/compare/v0.1.236...v0.1.237) (2026-07-22)

### Bug Fixes

* **desktop:** pin executableName to fix electron-builder 26 Linux packaging failure ([ea5e63d](https://github.com/kevinch3/NicotinD/commit/ea5e63db6adefbb7de255ad7d36d4d2355febd44))
## [0.1.236](https://github.com/kevinch3/NicotinD/compare/v0.1.235...v0.1.236) (2026-07-22)

### Features

* **admin:** consolidate admin telemetry into one polled resource ([8b62e93](https://github.com/kevinch3/NicotinD/commit/8b62e93556c607580b7d7d6a74445987e7f7f416))
## [0.1.235](https://github.com/kevinch3/NicotinD/compare/v0.1.234...v0.1.235) (2026-07-21)

### Features

* quality chip on download cards + spotDL credential/quality wiring ([0d5982a](https://github.com/kevinch3/NicotinD/commit/0d5982a805541ebeed0419594f0a0312b1728345))
## [0.1.234](https://github.com/kevinch3/NicotinD/compare/v0.1.233...v0.1.234) (2026-07-21)
## [0.1.233](https://github.com/kevinch3/NicotinD/compare/v0.1.232...v0.1.233) (2026-07-21)


### Features

* **acquire:** folder-first results + intuitive catalog-miss flow ([5e13dae](https://github.com/kevinch3/NicotinD/commit/5e13dae032175fd2bbe35610943b42c72892d42a))
* **acquire:** remind users lossless picks are stored as Opus ([fbe3c06](https://github.com/kevinch3/NicotinD/commit/fbe3c06df307cbd80248d72bf237469ed459e3fc))
* **hunt:** precise skew queries + shared core query builder ([a8ff991](https://github.com/kevinch3/NicotinD/commit/a8ff991c743970c6ebcca39e6920ac1a93dc1e68))


### Bug Fixes

* **search:** filter fuzzy first-token junk from catalog title search ([bbb888f](https://github.com/kevinch3/NicotinD/commit/bbb888f000c03e4efdda2d311eccca19a43956ef))
* **search:** hide the Soulseek peer lane when it isn't an available source ([d8f0458](https://github.com/kevinch3/NicotinD/commit/d8f0458805d1615614371e256defdf049345ef20))

## [0.1.232](https://github.com/kevinch3/NicotinD/compare/v0.1.231...v0.1.232) (2026-07-21)

## [0.1.231](https://github.com/kevinch3/NicotinD/compare/v0.1.230...v0.1.231) (2026-07-21)


### Features

* **api:** admin audit log for destructive actions ([17969cd](https://github.com/kevinch3/NicotinD/commit/17969cd4aa4d7ddcb6b7de80668dd8482e58fc31))
* **api:** daily backups (DB snapshot + secrets) with admin trigger ([f3e0d3a](https://github.com/kevinch3/NicotinD/commit/f3e0d3af9b2dcac8fea68eb9cb723d435db90f20))
* **api:** server update check + version-history ledger ([913b27b](https://github.com/kevinch3/NicotinD/commit/913b27b21c260c5b0d4f1462195d7e60ea976524))
* **deploy:** publish the analysis sidecar image; pin infra images ([459c627](https://github.com/kevinch3/NicotinD/commit/459c6271fb0330d7e07cb9dc7c2e5830494d2622))

## [0.1.230](https://github.com/kevinch3/NicotinD/compare/v0.1.229...v0.1.230) (2026-07-20)


### Features

* **api:** report the running version from /api/health ([6330539](https://github.com/kevinch3/NicotinD/commit/633053984486043165bb1184ba0f33c00df76adb))
* **deploy:** publish a multi-arch server image to GHCR; compose + deploy pull it ([dda3b78](https://github.com/kevinch3/NicotinD/commit/dda3b78c654adefa71c69229cae7a37978c05e01))


### Bug Fixes

* **docker:** probe /api/health in the image HEALTHCHECK ([e89c16a](https://github.com/kevinch3/NicotinD/commit/e89c16a86a6a7bbe1ed62e5ef60edd51c7141866))

## [0.1.229](https://github.com/kevinch3/NicotinD/compare/v0.1.228...v0.1.229) (2026-07-19)


### Features

* **pairing:** camera-scannable pairing links, working in-app QR scan, multi-server support ([8305b6a](https://github.com/kevinch3/NicotinD/commit/8305b6ad238898411d93f2d8c7afd0d1f622bca0))

## [0.1.228](https://github.com/kevinch3/NicotinD/compare/v0.1.227...v0.1.228) (2026-07-19)


### Features

* **desktop:** per-platform chrome + tray icon ([71ecccd](https://github.com/kevinch3/NicotinD/commit/71ecccd7ebea02b206bccd856e624b0a2b458fff))


### Bug Fixes

* **desktop:** pre-auth title-bar overlay, prod icon staging, use shouldHideOnClose ([bcbdf2f](https://github.com/kevinch3/NicotinD/commit/bcbdf2f4601cc464e60c061bfd6c4f3a4fc03145))

## [0.1.227](https://github.com/kevinch3/NicotinD/compare/v0.1.226...v0.1.227) (2026-07-18)


### Features

* **acquire:** auto-generate native playlists from playlist acquisitions ([8103157](https://github.com/kevinch3/NicotinD/commit/81031579c2eb882781fc59400d798284c9ccc95c))


### Bug Fixes

* **acquire:** make playlist generation actually fire for yt-dlp/spotdl + reuse playlist on retry ([36c7c0e](https://github.com/kevinch3/NicotinD/commit/36c7c0ede4d3cee9fa190c4adad516e632db95d2))

## [0.1.226](https://github.com/kevinch3/NicotinD/compare/v0.1.225...v0.1.226) (2026-07-18)


### Features

* **library:** surface local-album search hits + fragmentation diagnostic ([efb81e2](https://github.com/kevinch3/NicotinD/commit/efb81e240dbf30229d75ef136d071504ba2f2fad))


### Bug Fixes

* **search:** tokenized accent-insensitive matching + calibrate fragment diagnostic ([1e5783e](https://github.com/kevinch3/NicotinD/commit/1e5783e563ea5da5ef401acb12ca709e2fedfe78)), closes [#168](https://github.com/kevinch3/NicotinD/issues/168)

## [0.1.225](https://github.com/kevinch3/NicotinD/compare/v0.1.224...v0.1.225) (2026-07-18)


### Features

* **web:** manual PWA update check for frequent releases ([3716432](https://github.com/kevinch3/NicotinD/commit/3716432fcf985d35c078bf6b975d217dd99f596a))

## [0.1.224](https://github.com/kevinch3/NicotinD/compare/v0.1.223...v0.1.224) (2026-07-18)


### Bug Fixes

* guide through tailscale operator setup instead of raw sudo error ([a12ca7f](https://github.com/kevinch3/NicotinD/commit/a12ca7fd43e25ce712eb9f6bb47d4d2a70cc8eb3))

## [0.1.223](https://github.com/kevinch3/NicotinD/compare/v0.1.222...v0.1.223) (2026-07-18)


### Bug Fixes

* repair broken Linux deb + Android APK release builds ([f7235ea](https://github.com/kevinch3/NicotinD/commit/f7235ead88858d5051f0821b54de496e18891397)), closes [#150](https://github.com/kevinch3/NicotinD/issues/150) [#3](https://github.com/kevinch3/NicotinD/issues/3)

## [0.1.222](https://github.com/kevinch3/NicotinD/compare/v0.1.221...v0.1.222) (2026-07-18)


### Features

* link a phone by QR + remote access via Tailscale Funnel ([76b5bc7](https://github.com/kevinch3/NicotinD/commit/76b5bc7f0578f5217b409c0e7db796a1efede003))

## [0.1.221](https://github.com/kevinch3/NicotinD/compare/v0.1.220...v0.1.221) (2026-07-17)


### Bug Fixes

* **mobile:** prevent offline Android launch crash + detect network live ([c66827f](https://github.com/kevinch3/NicotinD/commit/c66827f4f172f6160d1af892fe5ce87423f094d9))

## [0.1.220](https://github.com/kevinch3/NicotinD/compare/v0.1.219...v0.1.220) (2026-07-17)


### Bug Fixes

* **web:** keep mobile track-row context menu clear of the player/tab bar ([679463e](https://github.com/kevinch3/NicotinD/commit/679463ebf357834544dcd6404eb271c701f589b5))
* **web:** wrap the Library Songs tab toolbar so it doesn't overflow on mobile ([3ae4557](https://github.com/kevinch3/NicotinD/commit/3ae45579467b18ee8b695cdc18aa058d1b3d0f8d))

## [0.1.219](https://github.com/kevinch3/NicotinD/compare/v0.1.218...v0.1.219) (2026-07-17)


### Bug Fixes

* **library:** appendable genres + artist rename, split & appears-on fixes ([17deedd](https://github.com/kevinch3/NicotinD/commit/17deedde32e073addd9103f51516cf5a16bfc119))

## [0.1.218](https://github.com/kevinch3/NicotinD/compare/v0.1.217...v0.1.218) (2026-07-17)


### Bug Fixes

* **docker:** skip lifecycle scripts in the production install ([dc2888f](https://github.com/kevinch3/NicotinD/commit/dc2888fb44c9edf094423b157091689c1dd86cf3))

## [0.1.217](https://github.com/kevinch3/NicotinD/compare/v0.1.216...v0.1.217) (2026-07-17)


### Bug Fixes

* **auth:** reflect current role in admin select + propagate role changes on reload ([adab39c](https://github.com/kevinch3/NicotinD/commit/adab39cbddcfdc8fd07e654f09b3da18999dfc65))

## [0.1.216](https://github.com/kevinch3/NicotinD/compare/v0.1.215...v0.1.216) (2026-07-17)


### Features

* **auth:** add listener + refiner user roles (capability ladder) ([56dad7c](https://github.com/kevinch3/NicotinD/commit/56dad7ccbbf8083eb90552268f194487a9a20838))

## [0.1.215](https://github.com/kevinch3/NicotinD/compare/v0.1.214...v0.1.215) (2026-07-17)


### Features

* **downloads:** show disk availability pill in Downloads header ([0b1e29c](https://github.com/kevinch3/NicotinD/commit/0b1e29c6ee72feed97eaebd0bf040396cc3c09df))
* **player:** resizable now-playing queue + styled lyrics empty state ([b497691](https://github.com/kevinch3/NicotinD/commit/b497691ea64a3ffd308b4e654a977f8341be2dd6))


### Bug Fixes

* **library:** reload artist view when navigating artist-to-artist ([4ddda45](https://github.com/kevinch3/NicotinD/commit/4ddda458462d2476cfcd2353007fb7cdbf3e4093))
* **lyrics:** make the first fetch reliable instead of a false empty ([128f93f](https://github.com/kevinch3/NicotinD/commit/128f93fae8e6cf1ed336f9d18d35de7728505be0))

## [0.1.214](https://github.com/kevinch3/NicotinD/compare/v0.1.213...v0.1.214) (2026-07-17)


### Features

* **web:** auto-preserve queue for PWA lock-screen resilience ([8857f2e](https://github.com/kevinch3/NicotinD/commit/8857f2ee35ac4a5aa4e6eff714c2a05d69d2deb2))
* **web:** songs search plus nav rationalisation ([d082507](https://github.com/kevinch3/NicotinD/commit/d082507a98a5b4cc224ce5daf51bd9f18a3903fe))

## [0.1.213](https://github.com/kevinch3/NicotinD/compare/v0.1.212...v0.1.213) (2026-07-17)


### Bug Fixes

* **acquire:** file tagless archive.org downloads instead of silently losing them ([13af34b](https://github.com/kevinch3/NicotinD/commit/13af34bb6fa74c8430df7e13bf8a85cf25f5a7fb))

## [0.1.212](https://github.com/kevinch3/NicotinD/compare/v0.1.211...v0.1.212) (2026-07-16)

## [0.1.211](https://github.com/kevinch3/NicotinD/compare/v0.1.210...v0.1.211) (2026-07-16)


### Bug Fixes

* **api:** make yt-dlp/spotdl usable from the desktop app ([5015484](https://github.com/kevinch3/NicotinD/commit/5015484c5f2876920cc671d26c7c75d485190ad9))
* **desktop:** ad-hoc sign the mac build so the arm64 app launches ([0db55c4](https://github.com/kevinch3/NicotinD/commit/0db55c472bd4862fca5853a3873b4552e9b703e0))
* **desktop:** restart sidecar after onboarding folder pick so the first session uses it ([31f496e](https://github.com/kevinch3/NicotinD/commit/31f496ea9c45b496c4a6ce5e8d3c7bee81a27575))
* **slskd:** auto-share the music dir and show a not-reachable notice ([3ea9681](https://github.com/kevinch3/NicotinD/commit/3ea9681b23077d604582917014fa66ee5bc40ac3))

## [0.1.210](https://github.com/kevinch3/NicotinD/compare/v0.1.209...v0.1.210) (2026-07-16)


### Features

* **web:** auto-preserve queue for PWA lock-screen resilience ([4565e33](https://github.com/kevinch3/NicotinD/commit/4565e3337ce66957673f0efc9f1f5ee56e22dc91))

## [0.1.209](https://github.com/kevinch3/NicotinD/compare/v0.1.208...v0.1.209) (2026-07-16)


### Bug Fixes

* **desktop:** default-import electron-updater (cjs) so packaged esm app boots ([2fff777](https://github.com/kevinch3/NicotinD/commit/2fff777b689c4e1a462f1bf63995c65d2899c487))

## [0.1.208](https://github.com/kevinch3/NicotinD/compare/v0.1.207...v0.1.208) (2026-07-16)


### Bug Fixes

* **desktop:** version electron-builder from release tag + add deb metadata ([ab6dcc5](https://github.com/kevinch3/NicotinD/commit/ab6dcc57e19b8d6991faf96db1b3da2421667854))

## [0.1.207](https://github.com/kevinch3/NicotinD/compare/v0.1.206...v0.1.207) (2026-07-16)


### Bug Fixes

* **desktop:** build with tsc -b so electron-builder finds dist/main.js ([b3de9c3](https://github.com/kevinch3/NicotinD/commit/b3de9c30ffcd6ff04c890a90a16000570ba670af))

## [0.1.206](https://github.com/kevinch3/NicotinD/compare/v0.1.205...v0.1.206) (2026-07-16)


### Bug Fixes

* **deploy:** stage desktop manifest for frozen install + run electron-builder under node ([a365936](https://github.com/kevinch3/NicotinD/commit/a365936d0270c7d1171a34d18bb7b9519b9c7981))

## [0.1.205](https://github.com/kevinch3/NicotinD/compare/v0.1.204...v0.1.205) (2026-07-16)


### Features

* **api:** allow NICOTIND_WEB_DIST override for packaged builds ([257838c](https://github.com/kevinch3/NicotinD/commit/257838cd23e76a4a3c2e6454774dd4320a570226))
* **api:** bind loopback + emit port handshake line for desktop sidecar ([5ddf75a](https://github.com/kevinch3/NicotinD/commit/5ddf75ad0a496963027a5216e328114641bf0b5a))
* **api:** resolve ffmpeg via NICOTIND_FFMPEG_PATH for packaged builds ([bac8d10](https://github.com/kevinch3/NicotinD/commit/bac8d109d8b8809e953e08871a327786750e0540))
* **desktop:** change music folder from settings + persist musicDir desktop-side ([f9e519b](https://github.com/kevinch3/NicotinD/commit/f9e519b6b99e939e22704704a12669f86fadfaaa))
* **desktop:** electron package scaffold + hardened main window ([addafda](https://github.com/kevinch3/NicotinD/commit/addafda751524a3c3921b828f684a0d17ae5b656))
* **desktop:** electron-builder packaging (AppImage/deb/dmg) with bundled ffmpeg + bun sidecar ([a3eb1a1](https://github.com/kevinch3/NicotinD/commit/a3eb1a1ea7c50adc67872d300c323511038a0f32))
* **desktop:** github-release auto-update (apply on linux, notify on unsigned macos) ([9eb418c](https://github.com/kevinch3/NicotinD/commit/9eb418c4437cc9196bd8d427855d2e22614d1f7d))
* **desktop:** preload native-capabilities bridge + folder-picker IPC ([feed768](https://github.com/kevinch3/NicotinD/commit/feed768ce60bccde91222236c8f1480c0c0b568c))
* **desktop:** supervised Bun sidecar with port handshake + logs ([28ab6c8](https://github.com/kevinch3/NicotinD/commit/28ab6c81d391fe708adfc45ae1c5a6fea5430ea1))
* **web:** disable service worker inside the Electron shell ([7e2af31](https://github.com/kevinch3/NicotinD/commit/7e2af310232bd78b29aef66fee0f44e9214c4f64))
* **web:** native folder picker in onboarding on Electron ([5498d5b](https://github.com/kevinch3/NicotinD/commit/5498d5b3c9fe4c29fe6ec5f204b2098e13d1775d))
* **web:** shared native-capabilities interface + Electron detection ([3d567e7](https://github.com/kevinch3/NicotinD/commit/3d567e79377d076b1180b618a527776c346fb30b))


### Bug Fixes

* **desktop:** guard sidecar restart on health, run desktop tests in CI ([7da1cc8](https://github.com/kevinch3/NicotinD/commit/7da1cc854e582fd1b6722afb66fddc734328f0c0))
* **desktop:** handle sidecar restart failure on music-folder change ([c966bfc](https://github.com/kevinch3/NicotinD/commit/c966bfc28ed4090abfcfd962a727abc4582e1a66))
* **desktop:** pin @types/node override so electron dep doesn't break workspace typecheck ([908d05c](https://github.com/kevinch3/NicotinD/commit/908d05c6452a0f017227ae198aee83e4de4db567))
* **desktop:** stage real version into backend package.json (not 0.0.0) ([d3a44c6](https://github.com/kevinch3/NicotinD/commit/d3a44c6c6cb8ba921567c8df9e08483c85282609))

## [0.1.204](https://github.com/kevinch3/NicotinD/compare/v0.1.203...v0.1.204) (2026-07-15)


### Features

* **radio:** mood/last-track radio landing + filter-seeded radio ([5d85b6f](https://github.com/kevinch3/NicotinD/commit/5d85b6faa8c5eaad5e4a65d1cdd890dfa1046734))

## [0.1.203](https://github.com/kevinch3/NicotinD/compare/v0.1.202...v0.1.203) (2026-07-14)


### Bug Fixes

* **stream:** actually apply the vocal-mute filter server-side ([08a8a32](https://github.com/kevinch3/NicotinD/commit/08a8a32cb27fb453a37edafb144ecabc22df8da8)), closes [#134](https://github.com/kevinch3/NicotinD/issues/134) [-#141](https://github.com/kevinch3/-/issues/141)

## [0.1.202](https://github.com/kevinch3/NicotinD/compare/v0.1.201...v0.1.202) (2026-07-14)


### Bug Fixes

* **web:** remove client-side vocal filter, keep backend-only vocal mute ([ec6cb08](https://github.com/kevinch3/NicotinD/commit/ec6cb0847f3324d3cf36d5008644a52d44d48441))

## [0.1.201](https://github.com/kevinch3/NicotinD/compare/v0.1.199...v0.1.201) (2026-07-14)


### Features

* **web:** promote recently-added to a Library Songs tab; simplify Offline ([a7a7abc](https://github.com/kevinch3/NicotinD/commit/a7a7abcb5d9879ab4c8f649654cc82efcdaebbca))


### Bug Fixes

* **web:** preserve playback position on vocal mute toggle via restoredTime ([49fc466](https://github.com/kevinch3/NicotinD/commit/49fc4660ed8c02c5826aad41f796cd4fb6a6eb9e))

## [0.1.199](https://github.com/kevinch3/NicotinD/compare/v0.1.198...v0.1.199) (2026-07-14)


### Features

* **acquire:** add emitTrack host-context method and shared track-event parsing ([56a8178](https://github.com/kevinch3/NicotinD/commit/56a8178fab15226a9492cbb32639ddbde4b3d679))
* **acquire:** add yt-dlp track markers and wire onTrack ([1fc191c](https://github.com/kevinch3/NicotinD/commit/1fc191c6eb15446dabf3666cd80e3540a2a88a4b))
* **acquire:** emit label and track events from archive plugin ([02557eb](https://github.com/kevinch3/NicotinD/commit/02557eb95fdfc89713567aee38b3b283808e7435))
* **acquire:** expose per-track status for slskd hunts through the job feed ([95f51bd](https://github.com/kevinch3/NicotinD/commit/95f51bd05af7c6e670954a238a784112916bfd02))
* **acquire:** wire spotdl onLabel and onTrack callbacks ([9dc3fe2](https://github.com/kevinch3/NicotinD/commit/9dc3fe21dd3acc85ae68925d273192101c61006b))
* **web:** show current/next track on download job cards ([4aef6fe](https://github.com/kevinch3/NicotinD/commit/4aef6fe5aa36bb97150538d27ec9055bd7dfc7a4))
* **web:** show View N albums for multi-album download jobs ([087aa8a](https://github.com/kevinch3/NicotinD/commit/087aa8a2d93048766b9ae15022df79c9fa822ee7))
* **web:** unify per-track status onto DownloadItem.tracks ([f211d74](https://github.com/kevinch3/NicotinD/commit/f211d747aa0c8fdb188542d3541c98700969d7c1))


### Bug Fixes

* **acquire:** strip file extension from archive track titles ([c249477](https://github.com/kevinch3/NicotinD/commit/c24947779bfc25f22f3ba8c4958ecd6fc327b56b))
* **acquire:** track distinct destination albums per job ([bb82b99](https://github.com/kevinch3/NicotinD/commit/bb82b9918c45b9389840af98d892e3462caf5a74))
* **web:** suppress misleading Now/Next display for slskd hunts ([5897bb0](https://github.com/kevinch3/NicotinD/commit/5897bb05c302ccebeee0ad462dd4ad53309e11ee))

## [0.1.198](https://github.com/kevinch3/NicotinD/compare/v0.1.197...v0.1.198) (2026-07-14)


### Features

* **web:** add VocalFilterService for client-side vocal removal ([eda30f1](https://github.com/kevinch3/NicotinD/commit/eda30f16f4ab16f418029d5d070a05e0748481ac))

## [0.1.197](https://github.com/kevinch3/NicotinD/compare/v0.1.196...v0.1.197) (2026-07-14)


### Bug Fixes

* **web:** preserve playback position across vocal-mute toggle ([53cd51a](https://github.com/kevinch3/NicotinD/commit/53cd51a3d7f62532b59c7460f9fe60573c61cd35))

## [0.1.196](https://github.com/kevinch3/NicotinD/compare/v0.1.195...v0.1.196) (2026-07-14)


### Bug Fixes

* **api:** use pan=c0-c1 (the only ffmpeg filter that actually cancels vocals) ([390cdb6](https://github.com/kevinch3/NicotinD/commit/390cdb63e6a7c055eed88a307a6892bf94802215))

## [0.1.195](https://github.com/kevinch3/NicotinD/compare/v0.1.194...v0.1.195) (2026-07-14)


### Bug Fixes

* **api:** embed filter version in transcode cache key ([34752b3](https://github.com/kevinch3/NicotinD/commit/34752b336d4f79380c37ca76dbf897585d585523))
* **api:** run vocal-removal branch before general transcode ([39d3e35](https://github.com/kevinch3/NicotinD/commit/39d3e359ba42c88bd147238232929574ea5e34a5))
* **web:** preserve playback position across vocal-mute toggle ([a8363e6](https://github.com/kevinch3/NicotinD/commit/a8363e60c5f0880f62dd7746d5689a9aa56c3ca1))

## [0.1.194](https://github.com/kevinch3/NicotinD/compare/v0.1.193...v0.1.194) (2026-07-14)


### Bug Fixes

* **api:** switch vocal removal to stereotools mid/side filter ([d3e101d](https://github.com/kevinch3/NicotinD/commit/d3e101d92fd7bb294443a6fdd0fbcac422981cc3))

## [0.1.193](https://github.com/kevinch3/NicotinD/compare/v0.1.192...v0.1.193) (2026-07-14)


### Features

* **api:** add ?vocals=off stream route param for karaoke ([630daa9](https://github.com/kevinch3/NicotinD/commit/630daa966ec32f997b94cf2de099b8aab8db9c79))
* **api:** add vocal removal filter to transcode pipeline ([242eff2](https://github.com/kevinch3/NicotinD/commit/242eff22ef0f383e66b5b8a0fc5d91ac0df293ad))
* **api:** include vocalRemoval flag in transcode cache key ([a4d7ec4](https://github.com/kevinch3/NicotinD/commit/a4d7ec4bd8050723baf3707bf9ce8d3f421403e6))
* **web:** add vocal mute mic toggle in karaoke overlay ([54b3638](https://github.com/kevinch3/NicotinD/commit/54b3638ca4b3e499f8c053c697b5b04090dad515))
* **web:** add vocalsMuted signal to PlayerService ([6692591](https://github.com/kevinch3/NicotinD/commit/66925918245b8e812cae7aad5e719cae1589c6ad))
* **web:** pass vocalsOff option through streamUrl ([2f7f504](https://github.com/kevinch3/NicotinD/commit/2f7f504ae88bad7fd16380a7249147a6f3b2bfa4))
* **web:** wire vocalsMuted to audio element src and add reload effect ([60c367a](https://github.com/kevinch3/NicotinD/commit/60c367a358033653731966244122502c318ae93d))

## [0.1.192](https://github.com/kevinch3/NicotinD/compare/v0.1.191...v0.1.192) (2026-07-14)


### Features

* **web:** collapse every peer folder of one album into a single download card ([2e68adf](https://github.com/kevinch3/NicotinD/commit/2e68adf581ad373e075d3b238af732c26e6472aa))

## [0.1.191](https://github.com/kevinch3/NicotinD/compare/v0.1.190...v0.1.191) (2026-07-14)


### Features

* **api:** acquisition-job stage tracking through the download pipeline ([f663210](https://github.com/kevinch3/NicotinD/commit/f6632100661071d2cf79cccfe971de39efd0e307))
* **api:** legacy album_jobs readers UNION the unified acquisition_jobs ([17ac6ae](https://github.com/kevinch3/NicotinD/commit/17ac6ae190d84cee2a8519fccf486cf8e237ca4d))
* **api:** pre-fill genre/year from acquisition-job metadata at scan time ([c1047dd](https://github.com/kevinch3/NicotinD/commit/c1047ddfbaaa2f951d9a028cfff65cae8a429d96))
* **api:** unified acquisition jobs — schema, store, enqueue-time recording ([083d08a](https://github.com/kevinch3/NicotinD/commit/083d08a4a90d1b2b3d8131159e66b7bc4c8d788f))
* unified acquisition-job feed — stored-key enrichment, /downloads/jobs, web stage merge ([8e375c1](https://github.com/kevinch3/NicotinD/commit/8e375c13806b734c4a345ff31bc530eb54ce2bf0))

## [0.1.190](https://github.com/kevinch3/NicotinD/compare/v0.1.189...v0.1.190) (2026-07-13)


### Features

* **library:** multi-genre consumers — filters, radio, recipes, enrichment ([f9b0b04](https://github.com/kevinch3/NicotinD/commit/f9b0b0437e1b7b0630a83b7ec982f134f89cab44))
* **library:** reclassify-genres propose/apply script for genre aliases ([92015ed](https://github.com/kevinch3/NicotinD/commit/92015ed37c40e3cabafd995bbf8283647770aa90))
* **library:** scanner populates multi-genre join table from full tag frames ([a8e8285](https://github.com/kevinch3/NicotinD/commit/a8e82855c51dd4156989326adcde51850e0f698a))
* **library:** splitGenres parser + genre alias/join-table schema ([60acec9](https://github.com/kevinch3/NicotinD/commit/60acec9d63a9e1b7528cd3460831734f82aaac6b))
* **web:** genre chips in track-info sheet (full set, primary highlighted) ([1059550](https://github.com/kevinch3/NicotinD/commit/1059550831c2149da904a678754c06c835a83463))

## [0.1.189](https://github.com/kevinch3/NicotinD/compare/v0.1.188...v0.1.189) (2026-07-13)


### Features

* **acquire:** resume truncated jobs in place instead of restarting from scratch ([dc15d2c](https://github.com/kevinch3/NicotinD/commit/dc15d2c2c3d5e7badd4e4f10badd38a150874483))


### Bug Fixes

* **acquire:** clear stale progress column when retryJob resumes a job ([bc1b613](https://github.com/kevinch3/NicotinD/commit/bc1b613033c4234519fb7fa58958cda22c33daa0))
* **acquire:** keep a failed job's staging dir until success or deletion ([c215055](https://github.com/kevinch3/NicotinD/commit/c2150555dea01ad5f3d1ad5fd97356ceef8dbe05))
* correct resume-mechanism doc scope + clear storage_path on retry ([1fda6c7](https://github.com/kevinch3/NicotinD/commit/1fda6c7df2bda5a47e658c816332cc2455728e7b))
* **spotdl:** pass --overwrite skip to make retries idempotent on already-downloaded tracks ([0a8860e](https://github.com/kevinch3/NicotinD/commit/0a8860e89392b7148288addd6fefa50af68712af))

## [0.1.188](https://github.com/kevinch3/NicotinD/compare/v0.1.187...v0.1.188) (2026-07-13)


### Bug Fixes

* **player:** don't autoplay on page load by default; add opt-in user setting ([260f062](https://github.com/kevinch3/NicotinD/commit/260f06271bbb249ffe04aea28526c322a1e32ea7))

## [0.1.187](https://github.com/kevinch3/NicotinD/compare/v0.1.186...v0.1.187) (2026-07-13)


### Bug Fixes

* **docker:** replace curl-based slskd healthcheck with bash /dev/tcp probe ([9379511](https://github.com/kevinch3/NicotinD/commit/9379511c61ab52139f10da0b2b0f3f3af1691966))

## [0.1.186](https://github.com/kevinch3/NicotinD/compare/v0.1.185...v0.1.186) (2026-07-13)


### Bug Fixes

* **web:** suppress stale acquire-job toasts on app open ([eed3120](https://github.com/kevinch3/NicotinD/commit/eed312093c557b1eadbccf489e557c6c54108e39))

## [0.1.185](https://github.com/kevinch3/NicotinD/compare/v0.1.184...v0.1.185) (2026-07-13)


### Bug Fixes

* **acquire:** unblock YouTube-backed downloads and fail restart-orphaned jobs ([0312b92](https://github.com/kevinch3/NicotinD/commit/0312b92ec0d1fab703c4cff2c46daeb7125a579a))

## [0.1.184](https://github.com/kevinch3/NicotinD/compare/v0.1.183...v0.1.184) (2026-07-13)


### Features

* **api:** artist spelling-variant aliases applied before ID minting ([a55a4f5](https://github.com/kevinch3/NicotinD/commit/a55a4f5fbe57b3c594ab7bc0a53f7eada11e6468))
* **api:** hide split-compound artist entities from the artists grid ([96d3343](https://github.com/kevinch3/NicotinD/commit/96d33438164d83887f7bb1efca03df36bd346145))
* user-fixable artist splits & merges (admin, permanent authority) ([e392ad5](https://github.com/kevinch3/NicotinD/commit/e392ad5a34adf2ded65667d3c800690834f99636))

## [0.1.183](https://github.com/kevinch3/NicotinD/compare/v0.1.182...v0.1.183) (2026-07-13)


### Features

* **api:** persist canonical artist identity at acquisition time ([ec78d5f](https://github.com/kevinch3/NicotinD/commit/ec78d5f70c6192924e52af7329ca8aeffe7c1358))

## [0.1.182](https://github.com/kevinch3/NicotinD/compare/v0.1.181...v0.1.182) (2026-07-12)


### Features

* **web:** wire Sync library button to POST /api/library/sync ([c23a758](https://github.com/kevinch3/NicotinD/commit/c23a7589c7881eb62e7019bb325465944b800881))

## [0.1.181](https://github.com/kevinch3/NicotinD/compare/v0.1.180...v0.1.181) (2026-07-12)


### Features

* **library:** confirmation-gated multi-artist splitting ([2fa57c5](https://github.com/kevinch3/NicotinD/commit/2fa57c58a333782edac90f74c5b5a68e70707d5d))

## [0.1.180](https://github.com/kevinch3/NicotinD/compare/v0.1.179...v0.1.180) (2026-07-11)


### Features

* **processing:** quarantine downloads until required steps complete before landing ([5d1a358](https://github.com/kevinch3/NicotinD/commit/5d1a358cd17ece3aa8c55c54360f6b158d974760))

## [0.1.179](https://github.com/kevinch3/NicotinD/compare/v0.1.178...v0.1.179) (2026-07-11)


### Bug Fixes

* **repo:** actually untrack docker-compose.override.yml ([c34dbf7](https://github.com/kevinch3/NicotinD/commit/c34dbf760773ae5a045bec0ca46e821d8f347e92))

## [0.1.178](https://github.com/kevinch3/NicotinD/compare/v0.1.177...v0.1.178) (2026-07-11)

## [0.1.177](https://github.com/kevinch3/NicotinD/compare/v0.1.176...v0.1.177) (2026-07-11)


### Bug Fixes

* **library:** repair BPM octave errors with Essentia sidecar-first detection ([4de68d2](https://github.com/kevinch3/NicotinD/commit/4de68d2029713b0557a99a4cdca8598a0b97033e))

## [0.1.176](https://github.com/kevinch3/NicotinD/compare/v0.1.175...v0.1.176) (2026-07-10)


### Features

* **web:** clear queue + drag-and-drop reorder in Now Playing ([dfd997c](https://github.com/kevinch3/NicotinD/commit/dfd997cad042f8c12b953b1623ff59922c53d4ef))
* **web:** per-row remove from Now Playing queue ([5c36d01](https://github.com/kevinch3/NicotinD/commit/5c36d019f545cddeed594290ff3020d4f337d12d))

## [0.1.175](https://github.com/kevinch3/NicotinD/compare/v0.1.174...v0.1.175) (2026-07-10)


### Bug Fixes

* **download-pipeline:** flag truncated spotdl/ytdlp downloads and stop duplicate acquire jobs ([462f39b](https://github.com/kevinch3/NicotinD/commit/462f39b41825e4487692332c0429873f6a3af2c4))

## [0.1.174](https://github.com/kevinch3/NicotinD/compare/v0.1.173...v0.1.174) (2026-07-10)


### Bug Fixes

* **library-processing:** ledger audio-features (422) + genre failures so the drain can't stall ([4ea0bb2](https://github.com/kevinch3/NicotinD/commit/4ea0bb26e8f6da6ce63eacf5e0810105be517454))

## [0.1.173](https://github.com/kevinch3/NicotinD/compare/v0.1.172...v0.1.173) (2026-07-10)


### Features

* **web:** add SongMenuService as single source of truth for song menus ([7d1cf82](https://github.com/kevinch3/NicotinD/commit/7d1cf8293f5a64474449451b3e5d15742570ce55))
* **web:** add track albumid and playerservice queuenext/startradio ([1423382](https://github.com/kevinch3/NicotinD/commit/1423382c6ed1dd3a0c671fa1bc36428971450ebe))
* **web:** global ConfirmService + confirm dialog ([b6dc86e](https://github.com/kevinch3/NicotinD/commit/b6dc86ee534bf51eb070ac3e957ed2bf8eb988e8))
* **web:** global TrackInfoService + host, delegate now-playing to it ([7b29980](https://github.com/kevinch3/NicotinD/commit/7b29980fb68f30456297ab254446cc70d155abeb))
* **web:** thread albumId through BaseSong/toTrack ([80646d7](https://github.com/kevinch3/NicotinD/commit/80646d7d9f0e5f55cad8c3142495151a58f809d7))


### Bug Fixes

* **web:** downloads recent count/empty-state track the deletedSongIds-filtered list ([dfd80d0](https://github.com/kevinch3/NicotinD/commit/dfd80d0e1137903a31002f470360d06abceb1004))
* **web:** generate missing covers for perceptual-shelf curated playlists ([7589ad3](https://github.com/kevinch3/NicotinD/commit/7589ad300b75ea11cc18746c0e65fce616c5da07))
* **web:** restore ConfirmDialogComponent, put global confirm under app-confirm-host ([0a2f8f7](https://github.com/kevinch3/NicotinD/commit/0a2f8f7510896ac9b0e7824086a61bb4b974c76e))

## [0.1.172](https://github.com/kevinch3/NicotinD/compare/v0.1.171...v0.1.172) (2026-07-09)


### Features

* **api:** standardized library metadata filters on all list routes ([7aec2f2](https://github.com/kevinch3/NicotinD/commit/7aec2f22edcc28664b06ee46a528e19fe32cd4af))
* **web:** metadata filters on the artist Songs tab + e2e filter flow ([f70ca64](https://github.com/kevinch3/NicotinD/commit/f70ca64718cb975817851b720be47c092cfc8eb3))
* **web:** standardized metadata filter panel on the four library tabs ([05321c1](https://github.com/kevinch3/NicotinD/commit/05321c11100b6c9b4299bdeccc19646bdc666e9f))

## [0.1.171](https://github.com/kevinch3/NicotinD/compare/v0.1.170...v0.1.171) (2026-07-09)


### Bug Fixes

* **api:** demote compilation reissues in catalog album ranking ([d91f9a4](https://github.com/kevinch3/NicotinD/commit/d91f9a4f202ad623097416c686b525207a73afb5))

## [0.1.170](https://github.com/kevinch3/NicotinD/compare/v0.1.169...v0.1.170) (2026-07-09)


### Features

* **web:** add Sims-style track stats bars to track info sheet ([c0cde91](https://github.com/kevinch3/NicotinD/commit/c0cde91a3401d33d74c7bd5af14f3fabbcfe78ec))

## [0.1.169](https://github.com/kevinch3/NicotinD/compare/v0.1.168...v0.1.169) (2026-07-09)


### Features

* **web:** add parseLinkIntent to classify pasted URLs by host ([d27282d](https://github.com/kevinch3/NicotinD/commit/d27282d68107606bbdab865936a4b9056c73321e))
* **web:** let the source chip render link-intent hosts ([3661ffe](https://github.com/kevinch3/NicotinD/commit/3661ffe1eba0f71346be963c4c65d36fbbb23d95))
* **web:** merge the URL acquire box into the search omnibox ([ac028de](https://github.com/kevinch3/NicotinD/commit/ac028de496fa99c8a4f1b9a59f5691ecbd5e6985))


### Bug Fixes

* **web:** clear stale results under the link-intent card ([263cc90](https://github.com/kevinch3/NicotinD/commit/263cc9037ac52631f38254c53ed03eec48963a44))

## [0.1.168](https://github.com/kevinch3/NicotinD/compare/v0.1.167...v0.1.168) (2026-07-08)


### Features

* **library:** upload a custom album cover image ([cf29fca](https://github.com/kevinch3/NicotinD/commit/cf29fca51bd56ebf63cc501d1b095605a209c76c))
* **web:** upload a custom album cover image from the Fix-metadata modal ([103707b](https://github.com/kevinch3/NicotinD/commit/103707b0bfc5e98f12e352c07e79f42748c1e574))


### Bug Fixes

* **library:** clear cover negative-cache after album artwork writes ([b74b288](https://github.com/kevinch3/NicotinD/commit/b74b288208d848d68e9acabe39c2fd920ce2756a))

## [0.1.167](https://github.com/kevinch3/NicotinD/compare/v0.1.166...v0.1.167) (2026-07-08)


### Features

* **lyrics:** merge lyrics and karaoke into a single feature ([ad1aee4](https://github.com/kevinch3/NicotinD/commit/ad1aee47b8181dafae346c0c6401564075e13acb))

## [0.1.166](https://github.com/kevinch3/NicotinD/compare/v0.1.165...v0.1.166) (2026-07-08)


### Bug Fixes

* **library-scanner:** strip glued track-number prefix from inferred artist ([a68d131](https://github.com/kevinch3/NicotinD/commit/a68d13184ab489b4417bc2d3aa9294df6e3b1f86))

## [0.1.165](https://github.com/kevinch3/NicotinD/compare/v0.1.164...v0.1.165) (2026-07-08)


### Features

* **downloads:** deep-link completed downloads to their album ([50db5dc](https://github.com/kevinch3/NicotinD/commit/50db5dca3d96e6464c0322459fab932ac4f0ff8c))

## [0.1.164](https://github.com/kevinch3/NicotinD/compare/v0.1.163...v0.1.164) (2026-07-08)


### Features

* **settings:** decouple Admin/Settings/Extensions and add slskd status panel ([8447f99](https://github.com/kevinch3/NicotinD/commit/8447f99afeb0b1c31aaaa15b73f1c4137de51af7))


### Bug Fixes

* **web:** repair AOT build — decorator placement + slskd type re-exports ([ef58a27](https://github.com/kevinch3/NicotinD/commit/ef58a278ea0a21ab30f4e917aac59bf512ef6121))

## [0.1.163](https://github.com/kevinch3/NicotinD/compare/v0.1.162...v0.1.163) (2026-07-08)


### Performance

* **radio:** weight-normalized scoring + embeddings for better matchmaking ([83c2c75](https://github.com/kevinch3/NicotinD/commit/83c2c758b36a6df37d6604eeba3da0b0235ce803))

## [0.1.162](https://github.com/kevinch3/NicotinD/compare/v0.1.161...v0.1.162) (2026-07-08)


### Features

* **analysis:** optional GPU inference via --build-arg GPU=1, with inherent CPU fallback ([dee93da](https://github.com/kevinch3/NicotinD/commit/dee93da24e4688a3619c077f1783a749bad083bf))


### Bug Fixes

* **library-processing:** treat a process restart as a failure-tally session boundary ([6a8ea23](https://github.com/kevinch3/NicotinD/commit/6a8ea23f124b77aa2f8867e3b8f65ea093ca9cf8))

## [0.1.161](https://github.com/kevinch3/NicotinD/compare/v0.1.160...v0.1.161) (2026-07-08)


### Bug Fixes

* **library-processing:** unwedge stuck enrichment backlog + stop stale failure banner ([845f63a](https://github.com/kevinch3/NicotinD/commit/845f63a3ac1950b5bc31d0cf98c2e0790b29c819))

## [0.1.160](https://github.com/kevinch3/NicotinD/compare/v0.1.159...v0.1.160) (2026-07-07)


### Features

* **library-processing:** exclude permanently-broken files + harden the analysis runtime ([520805d](https://github.com/kevinch3/NicotinD/commit/520805d558e916813a6d77b79e24e7b39dae587d))

## [0.1.159](https://github.com/kevinch3/NicotinD/compare/v0.1.158...v0.1.159) (2026-07-07)


### Features

* **library-processing:** diagnose enrichment failures, surface them, report to Sentry ([d3a60b3](https://github.com/kevinch3/NicotinD/commit/d3a60b36bebd8d649e9ffdb952c8aa6ebf3524fa))

## [0.1.158](https://github.com/kevinch3/NicotinD/compare/v0.1.157...v0.1.158) (2026-07-07)


### Bug Fixes

* **api:** detect ALAC hiding in .m4a so it gets standardized to Opus ([b23d2b2](https://github.com/kevinch3/NicotinD/commit/b23d2b220cbcc9b8d64209001284e3fc9294e506))

## [0.1.157](https://github.com/kevinch3/NicotinD/compare/v0.1.156...v0.1.157) (2026-07-07)


### Bug Fixes

* **web:** stop the track-load effect from aborting its own stream loads ([7fc96d1](https://github.com/kevinch3/NicotinD/commit/7fc96d1e5e9d283aee3391e350665b5a1d0b9c3f))

## [0.1.156](https://github.com/kevinch3/NicotinD/compare/v0.1.155...v0.1.156) (2026-07-07)


### Features

* **web:** show success toast when URL acquire job completes ([071a8bf](https://github.com/kevinch3/NicotinD/commit/071a8bf2a6fe693d2127fe6206f2fb5f6eb49584)), closes [#85](https://github.com/kevinch3/NicotinD/issues/85)


### Bug Fixes

* **web:** bypass the Angular service worker for audio stream requests ([034cfab](https://github.com/kevinch3/NicotinD/commit/034cfabe3e15b32e2414dca2d589f01bbad0d5e0)), closes [#87](https://github.com/kevinch3/NicotinD/issues/87)
* **web:** route the standby-preload stream URL through streamUrl too ([7ad07d3](https://github.com/kevinch3/NicotinD/commit/7ad07d377af46e434bb7102014403a8d2e575374))

## [0.1.155](https://github.com/kevinch3/NicotinD/compare/v0.1.154...v0.1.155) (2026-07-07)


### Bug Fixes

* **api:** stop Firefox <audio> from stalling forever on stream requests ([0f1d0b7](https://github.com/kevinch3/NicotinD/commit/0f1d0b7622057bb8427d1100fd29473cfd7fee97))

## [0.1.154](https://github.com/kevinch3/NicotinD/compare/v0.1.153...v0.1.154) (2026-07-07)


### Features

* **web:** add buffered-range segment + gradient helpers ([8923c94](https://github.com/kevinch3/NicotinD/commit/8923c947afd34b50cf35752ed023cf802406fce7))
* **web:** add buffering + bufferedRanges state to PlayerService ([4820888](https://github.com/kevinch3/NicotinD/commit/4820888ec415bae16995d08dd880331961040ddc))
* **web:** current-track indicator with instant click acknowledgment on track rows ([2966053](https://github.com/kevinch3/NicotinD/commit/29660538f28c6a642491f658b4ee5acd2f650b6c))
* **web:** drive buffering state from native audio events ([6f2b728](https://github.com/kevinch3/NicotinD/commit/6f2b728069ee12ae2dc78100c98f5a8dfb3da957))
* **web:** paint buffered ranges band on the seek bar ([29ca727](https://github.com/kevinch3/NicotinD/commit/29ca7275acc162f9679afe281a96cd943ba26322))
* **web:** show buffering spinner on play/pause buttons ([1f96c36](https://github.com/kevinch3/NicotinD/commit/1f96c36c334a704bb2aafb94b04f93effab41254))


### Bug Fixes

* **web:** clear buffering on seeked when the target is already buffered ([c00642c](https://github.com/kevinch3/NicotinD/commit/c00642c6e35a55301f6834915c0485d9bff18918))

## [0.1.153](https://github.com/kevinch3/NicotinD/compare/v0.1.152...v0.1.153) (2026-07-06)


### Bug Fixes

* **web:** pad now-playing sheet header with safe-area-inset-top ([2a46d72](https://github.com/kevinch3/NicotinD/commit/2a46d725227c071f4f39a5dc68820323b8d42aa0))

## [0.1.152](https://github.com/kevinch3/NicotinD/compare/v0.1.151...v0.1.152) (2026-07-06)


### Features

* **api:** opt-in server-side Sentry init helper ([10dd129](https://github.com/kevinch3/NicotinD/commit/10dd129155c45b3173ddc13565bf41b45190ae54))
* **api:** report unknown 500 errors to Sentry ([9ef78b0](https://github.com/kevinch3/NicotinD/commit/9ef78b0d0c3afcac13bed8224e1f41eff3a909c6))
* initialize server Sentry at boot (opt-in via env) ([5414bdc](https://github.com/kevinch3/NicotinD/commit/5414bdc7173e9929edbccccdab4df8c2483cbe70))
* integrate Sentry error tracking and session replay with custom CTA event directive ([6f59143](https://github.com/kevinch3/NicotinD/commit/6f591439ead38be3c279932bd692e007c915ffd6))
* **web:** testable opt-in Sentry init, disabled in dev ([4de7b67](https://github.com/kevinch3/NicotinD/commit/4de7b670fa287c9cf626db65490e69cb4b5093d0))


### Bug Fixes

* preload server Sentry before Hono; drop unused CTA directive ([8a6d3d0](https://github.com/kevinch3/NicotinD/commit/8a6d3d0b5ddce49ae1f9eefe800191a68c30b9c6))

## [0.1.151](https://github.com/kevinch3/NicotinD/compare/v0.1.150...v0.1.151) (2026-07-06)


### Bug Fixes

* resolve circular dependency in AuthService logout ([460aa1a](https://github.com/kevinch3/NicotinD/commit/460aa1af7bdaf6228af48bb8e347e0fdf209d1a1))
* **search:** don't clear query in reset() to preserve advanced toggle ([caa7d87](https://github.com/kevinch3/NicotinD/commit/caa7d87373c663e7f58a469d04564afca1d0f1a7))
* **search:** set networkState to complete on API failure ([315c3a7](https://github.com/kevinch3/NicotinD/commit/315c3a76d79c48f4f451f59245f5786a09dd97c6))
* **web:** clear all user state on logout to prevent data leaks ([abc4f23](https://github.com/kevinch3/NicotinD/commit/abc4f2348605bb96f9d5e5c2a054d007255abc4a))

## [0.1.150](https://github.com/kevinch3/NicotinD/compare/v0.1.149...v0.1.150) (2026-07-06)

## [0.1.149](https://github.com/kevinch3/NicotinD/compare/v0.1.148...v0.1.149) (2026-07-06)


### Bug Fixes

* **web:** migrate dark-island components to themed tokens ([982cc01](https://github.com/kevinch3/NicotinD/commit/982cc018afb23d9693e1cdf089a29971a4c660fc))
* **web:** register unregistered theme utilities (silent no-op classes) ([ea86e51](https://github.com/kevinch3/NicotinD/commit/ea86e511296f525d032d754671c6e5f01ca8ecff))
* **web:** themed status colours for warnings/pills (light-theme contrast) ([b488844](https://github.com/kevinch3/NicotinD/commit/b488844d16476702b38f1b695143e45a7212ec0c))
* **web:** use text-theme-on-accent for text on accent fills ([f6a7d9b](https://github.com/kevinch3/NicotinD/commit/f6a7d9bc9ac8856dbfe4d678ba682e164a621b99))

## [0.1.148](https://github.com/kevinch3/NicotinD/compare/v0.1.147...v0.1.148) (2026-07-06)


### Bug Fixes

* **web:** resolve lyrics overflow, badge contrast, and settings mobile overflow ([d883bbb](https://github.com/kevinch3/NicotinD/commit/d883bbb0a854a8b5d6fd88bf8e1a8255d522b639))

## [0.1.147](https://github.com/kevinch3/NicotinD/compare/v0.1.146...v0.1.147) (2026-07-05)

## [0.1.146](https://github.com/kevinch3/NicotinD/compare/v0.1.145...v0.1.146) (2026-07-04)

## [0.1.145](https://github.com/kevinch3/NicotinD/compare/v0.1.144...v0.1.145) (2026-07-04)


### Performance

* **web:** cache whole-library reads (artists, genres) ([0ebf753](https://github.com/kevinch3/NicotinD/commit/0ebf7533d26faf1c5b8d5bdd38689af85cd73f10))

## [0.1.144](https://github.com/kevinch3/NicotinD/compare/v0.1.143...v0.1.144) (2026-07-04)


### Performance

* **db:** tune SQLite pragmas, add grid index, cache suppression scan ([26545f6](https://github.com/kevinch3/NicotinD/commit/26545f68655e46d3123a7475b710fbd4e1221112))
* **scanner:** incremental tag cache skips re-parsing unchanged files ([03646ea](https://github.com/kevinch3/NicotinD/commit/03646ea618f2d4efb82870ebf7938eafe5624479))
* **web:** render-window large lists + debounce list search ([2edbe59](https://github.com/kevinch3/NicotinD/commit/2edbe5962301fac173b583fa968f71a904a22cb7))

## [0.1.143](https://github.com/kevinch3/NicotinD/compare/v0.1.142...v0.1.143) (2026-07-04)


### Bug Fixes

* **web:** provision CHANGELOG.md into Docker build so changelog modal isn't empty ([ac269ef](https://github.com/kevinch3/NicotinD/commit/ac269ef4ad7fa1959f779a6d03babad177d5d50b))

## [0.1.142](https://github.com/kevinch3/NicotinD/compare/v0.1.141...v0.1.142) (2026-07-03)


### Features

* **presence:** admin-only presence tracking via HTTP heartbeats ([abe9cd2](https://github.com/kevinch3/NicotinD/commit/abe9cd243177c91f0a1f20df5779c2f6caefeb26))

## [0.1.141](https://github.com/kevinch3/NicotinD/compare/v0.1.140...v0.1.141) (2026-07-03)


### Features

* **api:** native auto-acquisition loop over Lidarr wanted/missing ([5cbc6ba](https://github.com/kevinch3/NicotinD/commit/5cbc6ba5a638c318226ef48dcaf808edc80ca2d5))

## [0.1.140](https://github.com/kevinch3/NicotinD/compare/v0.1.139...v0.1.140) (2026-07-03)


### Features

* **analysis:** essentia audio-analysis sidecar (packages/analysis) ([73de8e6](https://github.com/kevinch3/NicotinD/commit/73de8e6c6a43059f86ccb9c7926dae59ffa30089))
* **library:** audio-features enrichment task wired to the analysis sidecar ([721d400](https://github.com/kevinch3/NicotinD/commit/721d4009823e9482e0abea5714074fd66d4e7e7a))
* **library:** perceptual feature storage + ffmpeg energy/loudness enrichment task ([c787c8e](https://github.com/kevinch3/NicotinD/commit/c787c8e5e81fe5881003eea7f34514d0fd56c7e0))
* **radio:** score and sequence on the perceptual features ([18fc725](https://github.com/kevinch3/NicotinD/commit/18fc725fca79dbdab9c63c5b6e0715323eedd024))
* **web:** show key + perceptual features in the track-info drawer ([911fd6c](https://github.com/kevinch3/NicotinD/commit/911fd6c3c93af46a06c42ee0709d30a84ea29210))


### Bug Fixes

* **library:** make Vorbis-family tag writes actually work + opus decode in sidecar ([1319826](https://github.com/kevinch3/NicotinD/commit/13198268979ef5987e7dd89c61e3fa2abbda63b4))

## [0.1.139](https://github.com/kevinch3/NicotinD/compare/v0.1.138...v0.1.139) (2026-07-03)


### Bug Fixes

* **docker:** install libvips-dev for sharp in web-builder stage ([b8d0d58](https://github.com/kevinch3/NicotinD/commit/b8d0d5862ed734cea1ddbaac635e76416db4a89a))
* **docker:** skip postinstall scripts in web-builder stage ([bd9d829](https://github.com/kevinch3/NicotinD/commit/bd9d8298e97f091cacf0c2e14def97fecde853cc))
* **web:** add type assertion for changelog.json import ([c9f10af](https://github.com/kevinch3/NicotinD/commit/c9f10af8e7b21da4f3a5efb219d91861763bc587))
* **web:** wrap artist image menu in positioned container ([88fa5c8](https://github.com/kevinch3/NicotinD/commit/88fa5c8424062967f3f009aa7bf9adfec4d31b7e))

## [0.1.138](https://github.com/kevinch3/NicotinD/compare/v0.1.137...v0.1.138) (2026-07-03)


### Bug Fixes

* **web:** handle missing CHANGELOG.md in Docker build + add OAuth docs ([34572a2](https://github.com/kevinch3/NicotinD/commit/34572a2c7434dc0cc2dd862c1eaef4a4e5dea12c))

## [0.1.137](https://github.com/kevinch3/NicotinD/compare/v0.1.136...v0.1.137) (2026-07-03)


### Features

* **web:** changelog modal on version click + fix hardcoded API version ([db592d7](https://github.com/kevinch3/NicotinD/commit/db592d76e0344435284995a07b0a7a9b777f389f))


### Bug Fixes

* **web:** add pretest hook to generate changelog.json before vitest ([bb9a170](https://github.com/kevinch3/NicotinD/commit/bb9a17070db70a89a1ebfb8f930754f97d56030c))

## [0.1.136](https://github.com/kevinch3/NicotinD/compare/v0.1.135...v0.1.136) (2026-07-02)


### Features

* **onboarding:** expanded setup wizard and first-login welcome banner ([6011a35](https://github.com/kevinch3/NicotinD/commit/6011a355da17dafa38631cf90a76187d0f1e4426))


### Bug Fixes

* **e2e:** add type=button to setup wizard buttons; wait for API 201 response ([9e66be8](https://github.com/kevinch3/NicotinD/commit/9e66be88ba065461f10bc39a74e6771370aee2d0))
* **onboarding:** enter app after setup + isolate wizard e2e on a fresh server ([bba3bdb](https://github.com/kevinch3/NicotinD/commit/bba3bdb48febc1565b07d1685cd958be19e26a74))

## [0.1.135](https://github.com/kevinch3/NicotinD/compare/v0.1.134...v0.1.135) (2026-07-02)


### Bug Fixes

* **artists:** admin delete on the Songs tab for albumless files ([6930a32](https://github.com/kevinch3/NicotinD/commit/6930a32609cadaac038ecf15b6a0ac27c3873b04))

## [0.1.134](https://github.com/kevinch3/NicotinD/compare/v0.1.133...v0.1.134) (2026-07-02)


### Bug Fixes

* **artists:** add hunt loading feedback + cover art timing fix ([b337f57](https://github.com/kevinch3/NicotinD/commit/b337f57951459aee704a4286d24ff2bab3d51ab1))

## [0.1.133](https://github.com/kevinch3/NicotinD/compare/v0.1.132...v0.1.133) (2026-07-02)


### Features

* **downloads:** expose destination albumId for deep-linking downloads ([11313cf](https://github.com/kevinch3/NicotinD/commit/11313cfe3f4d86817f465dacc76014981070e1c4))
* **library:** album-scoped reconcile scan + orphan-row prune ([816b607](https://github.com/kevinch3/NicotinD/commit/816b60743845c48e6855f96670c689b8cde8a6ba))
* **library:** organizer runs tag-aware reconcile, reports deleted paths + album dirs ([f7e5310](https://github.com/kevinch3/NicotinD/commit/f7e53102acaf63bf4a225daf7bf81dd6f450a441))
* **library:** reconcile whole album at download→library seam for both ingests ([4beab80](https://github.com/kevinch3/NicotinD/commit/4beab80bd909355bfe94617edad71fdf2c929e26))
* **library:** tag/title-aware album-folder reconciler (pure core) ([5257a4a](https://github.com/kevinch3/NicotinD/commit/5257a4a1f4827ba2cba37a4289d991948d602087))

## [0.1.132](https://github.com/kevinch3/NicotinD/compare/v0.1.131...v0.1.132) (2026-07-02)


### Features

* **playlists:** recipe-driven auto shelves + Radio-scored seed generator ([088a7ea](https://github.com/kevinch3/NicotinD/commit/088a7ea7db8c2cce6a34a5eff9f2075d49c402f9))

## [0.1.131](https://github.com/kevinch3/NicotinD/compare/v0.1.130...v0.1.131) (2026-07-01)


### Bug Fixes

* **web:** make search source chips & artist pills theme-aware ([5be6da5](https://github.com/kevinch3/NicotinD/commit/5be6da59a4efeb17402c8b208160d35cd08f0f8c))

## [0.1.130](https://github.com/kevinch3/NicotinD/compare/v0.1.129...v0.1.130) (2026-07-01)

## [0.1.129](https://github.com/kevinch3/NicotinD/compare/v0.1.128...v0.1.129) (2026-07-01)


### Features

* **web:** add AutoHuntService — headless hunt with countdown toast ([b5584b8](https://github.com/kevinch3/NicotinD/commit/b5584b88908b17da75b54f676c559fcd5e9766d9))
* **web:** add ToastOutletComponent, mount at app root ([bf7ace1](https://github.com/kevinch3/NicotinD/commit/bf7ace17df281d438289b104d4a2a54e8bfbc350))
* **web:** add ToastService with countdown and auto-dismiss ([36b8b1f](https://github.com/kevinch3/NicotinD/commit/36b8b1f1d2a47b274c25adec19dcb3c240e004ff))
* **web:** wire AutoHuntService into Find Album flow ([545cdfa](https://github.com/kevinch3/NicotinD/commit/545cdfac28b5b461b2fab48efd19093cc584ddb4))


### Bug Fixes

* **web:** dismiss actions close toast; enforce capacity cap with all-countdown toasts ([9c4faca](https://github.com/kevinch3/NicotinD/commit/9c4faca46c7edebea6eb9ea7a03f14004bebab11))
* **web:** never arm a timer for a dropped over-capacity toast ([19f1a2c](https://github.com/kevinch3/NicotinD/commit/19f1a2c780c12b3c21f2ed881afe22e8eb51a2af))

## [0.1.128](https://github.com/kevinch3/NicotinD/compare/v0.1.127...v0.1.128) (2026-07-01)

## [0.1.127](https://github.com/kevinch3/NicotinD/compare/v0.1.126...v0.1.127) (2026-07-01)


### Performance

* **web:** hold cover gradient until image loads, fix empty-state flash on tab switch ([85d42fb](https://github.com/kevinch3/NicotinD/commit/85d42fb1aaa73b7aa70daa3a934ca38bc03d30ae))

## [0.1.126](https://github.com/kevinch3/NicotinD/compare/v0.1.125...v0.1.126) (2026-07-01)


### Features

* multi-artist support with parsing, join tables, and linked UI ([e832c17](https://github.com/kevinch3/NicotinD/commit/e832c179f35f4e2fb5b1dea5c081f0b82cc6b74e))


### Bug Fixes

* lint unused var and e2e strict-mode violation from multi-artist links ([76f1641](https://github.com/kevinch3/NicotinD/commit/76f1641d38d734d895cd96e28b6d56589afa0211))

## [0.1.125](https://github.com/kevinch3/NicotinD/compare/v0.1.124...v0.1.125) (2026-07-01)


### Features

* va compilation handling with detection, per-track artists, and dedicated UI ([a884e51](https://github.com/kevinch3/NicotinD/commit/a884e510b11c5360790b4d3b89d6cc9d50d420d9))

## [0.1.124](https://github.com/kevinch3/NicotinD/compare/v0.1.123...v0.1.124) (2026-06-30)


### Features

* metadata-driven smart radio using BPM, key, and genre scoring ([a441861](https://github.com/kevinch3/NicotinD/commit/a4418616efaf04dd733d4e4e166a2997634bc637))

## [0.1.123](https://github.com/kevinch3/NicotinD/compare/v0.1.122...v0.1.123) (2026-06-30)

## [0.1.122](https://github.com/kevinch3/NicotinD/compare/v0.1.121...v0.1.122) (2026-06-30)


### Features

* real artist portraits with auto-fill + manual override ([90100f3](https://github.com/kevinch3/NicotinD/commit/90100f35a0ec5a0ac97a925b4085450e3d1f17d8))

## [0.1.121](https://github.com/kevinch3/NicotinD/compare/v0.1.120...v0.1.121) (2026-06-29)


### Bug Fixes

* load stored bpm/genre in track info sheet opened from player ([1942788](https://github.com/kevinch3/NicotinD/commit/194278840211cb9eda8a99ea5aee663e7985eab4))

## [0.1.120](https://github.com/kevinch3/NicotinD/compare/v0.1.119...v0.1.120) (2026-06-29)


### Bug Fixes

* stop "Complete Album" duplicating tracks + strengthen per-track hunt ([717e0c4](https://github.com/kevinch3/NicotinD/commit/717e0c472e41c8a814f5fe45fbe408b670257adf))

## [0.1.119](https://github.com/kevinch3/NicotinD/compare/v0.1.118...v0.1.119) (2026-06-29)


### Features

* implement fullscreen karaoke mode with synchronized lyrics display and playback controls ([3f41beb](https://github.com/kevinch3/NicotinD/commit/3f41beb4ded21a411934fc0813878c88c28073e8))

## [0.1.118](https://github.com/kevinch3/NicotinD/compare/v0.1.117...v0.1.118) (2026-06-29)


### Bug Fixes

* prevent app crashes by validating artwork URLs before native processing ([60938fb](https://github.com/kevinch3/NicotinD/commit/60938fb766ceae9dd6fbf5fdd4a64e5e9b72f23a))

## [0.1.117](https://github.com/kevinch3/NicotinD/compare/v0.1.116...v0.1.117) (2026-06-27)


### Features

* **search:** artist pill opens the artist or loads their discography ([9eef0c3](https://github.com/kevinch3/NicotinD/commit/9eef0c3ab9e181915e6d0eff40bf2c5b00778c70))

## [0.1.116](https://github.com/kevinch3/NicotinD/compare/v0.1.115...v0.1.116) (2026-06-26)


### Bug Fixes

* **transcode:** don't crash library migration on a pre-existing opus acquisitions row ([4e1b044](https://github.com/kevinch3/NicotinD/commit/4e1b044a660a38848ba32b7c88790835c786b649))

## [0.1.115](https://github.com/kevinch3/NicotinD/compare/v0.1.114...v0.1.115) (2026-06-26)


### Features

* **scripts:** add --no-trim to repair-album-folders (consolidate without dropping remixes) ([bc52f36](https://github.com/kevinch3/NicotinD/commit/bc52f360b0f6628777b7eb88a65265a4fdf118ac))

## [0.1.114](https://github.com/kevinch3/NicotinD/compare/v0.1.113...v0.1.114) (2026-06-25)


### Features

* **library:** on-disk edition consolidation, in-flight download suppression, default-on Opus ([e84a03a](https://github.com/kevinch3/NicotinD/commit/e84a03a746016f9e69db13037e5f9300ecc7fa4d))

## [0.1.113](https://github.com/kevinch3/NicotinD/compare/v0.1.112...v0.1.113) (2026-06-25)

## [0.1.112](https://github.com/kevinch3/NicotinD/compare/v0.1.111...v0.1.112) (2026-06-25)


### Features

* musical key analyzer + enrichment durability fix ([7adbd46](https://github.com/kevinch3/NicotinD/commit/7adbd4668467e65403973117b80b76a11f93b3c0))

## [0.1.111](https://github.com/kevinch3/NicotinD/compare/v0.1.110...v0.1.111) (2026-06-24)


### Features

* windowed background library enrichment (BPM/genre) ([be35f97](https://github.com/kevinch3/NicotinD/commit/be35f9779a234bcc854a92931575341af945375e))

## [0.1.110](https://github.com/kevinch3/NicotinD/compare/v0.1.109...v0.1.110) (2026-06-24)


### Features

* unify bottom-chrome stacking, scroll-lock full-screen sheets, fold downloads badge into nav ([a724f57](https://github.com/kevinch3/NicotinD/commit/a724f574c68c0febed34e800dc3e3c28dd0c8b89))


### Bug Fixes

* **web:** register bg-theme-muted utility so the grab notch isn't transparent ([176ecf3](https://github.com/kevinch3/NicotinD/commit/176ecf3056614c20e8722c14a1e055991ba15560))

## [0.1.109](https://github.com/kevinch3/NicotinD/compare/v0.1.108...v0.1.109) (2026-06-24)


### Features

* fix playlist sharing + server-side OG link previews ([86216b4](https://github.com/kevinch3/NicotinD/commit/86216b4604cc464f022a152aec75a3fa3aecfdbc))

## [0.1.108](https://github.com/kevinch3/NicotinD/compare/v0.1.107...v0.1.108) (2026-06-24)


### Features

* album cover picker + drop redundant per-track thumbnails ([4fd62c7](https://github.com/kevinch3/NicotinD/commit/4fd62c7fdf946aa98b7eb1642df05d05ad066f73))
* bulk BPM/genre backfill scripts ([6221c7f](https://github.com/kevinch3/NicotinD/commit/6221c7f1761b02cabed2d0ff52118a5547622a96))

## [0.1.107](https://github.com/kevinch3/NicotinD/compare/v0.1.106...v0.1.107) (2026-06-23)


### Features

* on-demand lyrics via a metadata-kind plugin (LRCLIB) ([974aa03](https://github.com/kevinch3/NicotinD/commit/974aa037c6e29e50fe6d9f43f219283d42cc1859))

## [0.1.106](https://github.com/kevinch3/NicotinD/compare/v0.1.105...v0.1.106) (2026-06-23)


### Features

* artist songs tab, playlist sharing, faster thumbnails, viewport-safe menus ([8510b17](https://github.com/kevinch3/NicotinD/commit/8510b1717bcc475a25d133e0b17f9758ee98fd96))

## [0.1.105](https://github.com/kevinch3/NicotinD/compare/v0.1.104...v0.1.105) (2026-06-23)


### Features

* curated playlists with gradient covers ([024ab10](https://github.com/kevinch3/NicotinD/commit/024ab1082e053e5075720e94d14f296600f75c89))

## [0.1.104](https://github.com/kevinch3/NicotinD/compare/v0.1.103...v0.1.104) (2026-06-22)


### Features

* album-hunt-modal ([5e6edc2](https://github.com/kevinch3/NicotinD/commit/5e6edc22c536f44e36a780cbf3126a6cded04da5))


### Bug Fixes

* **web:** add missing hunt-download-outcome module ([5d42dc3](https://github.com/kevinch3/NicotinD/commit/5d42dc3afd78083cf0c8c942b0c43fe9ace65bd9))

## [0.1.103](https://github.com/kevinch3/NicotinD/compare/v0.1.102...v0.1.103) (2026-06-22)


### Features

* **library:** quality auditor with pollution cleanup, re-tag & offline year backfill ([21fc3c9](https://github.com/kevinch3/NicotinD/commit/21fc3c9d36c2a3faf62093b06bd992eb438fc968))

## [0.1.102](https://github.com/kevinch3/NicotinD/compare/v0.1.101...v0.1.102) (2026-06-22)


### Features

* **acquire:** source-agnostic candidate model, blended search + hunt aggregation ([758443d](https://github.com/kevinch3/NicotinD/commit/758443dea4513d072cb9849b51bb1702ae591ed9))
* **hunt:** blend archive.org + Spotify into one chip-labelled list in the album-hunt modal ([6618a54](https://github.com/kevinch3/NicotinD/commit/6618a54f7f8e50c2d2c554824b5cfe2cc50eb140))
* **search:** blended source-agnostic results list with source chips ([e94bd87](https://github.com/kevinch3/NicotinD/commit/e94bd87ad168b9f096f8fed545a7216dccc98b6e))

## [0.1.101](https://github.com/kevinch3/NicotinD/compare/v0.1.100...v0.1.101) (2026-06-21)


### Bug Fixes

* **settings:** return empty config when secrets.json is absent ([9989aed](https://github.com/kevinch3/NicotinD/commit/9989aed2321d61f320d3a38e2d05494bced8ebda))

## [0.1.100](https://github.com/kevinch3/NicotinD/compare/v0.1.99...v0.1.100) (2026-06-21)

## [0.1.99](https://github.com/kevinch3/NicotinD/compare/v0.1.98...v0.1.99) (2026-06-20)


### Bug Fixes

* **ios:** reclaim Now Playing session after an audio interruption ([6c22109](https://github.com/kevinch3/NicotinD/commit/6c22109db1b6154ee8f380619399763ed49dbb49))

## [0.1.98](https://github.com/kevinch3/NicotinD/compare/v0.1.97...v0.1.98) (2026-06-20)


### Bug Fixes

* **ios:** make the lock-screen Now Playing card work via native session ownership ([33c6464](https://github.com/kevinch3/NicotinD/commit/33c64645d820ba50e91a13c7f288f293be4afbcb))

## [0.1.97](https://github.com/kevinch3/NicotinD/compare/v0.1.96...v0.1.97) (2026-06-20)


### Features

* **auth:** sliding 30d sessions + vibrant glassmorphic login ([06b0d06](https://github.com/kevinch3/NicotinD/commit/06b0d066e8a8d78c471a0067a0090b199d0893ed))

## [0.1.96](https://github.com/kevinch3/NicotinD/compare/v0.1.95...v0.1.96) (2026-06-20)


### Bug Fixes

* **ci:** force-fetch tags on deploy so a divergent local tag can't block it ([e066616](https://github.com/kevinch3/NicotinD/commit/e06661627c24fcb0fea38b812175754a76b28f68))

## [0.1.95](https://github.com/kevinch3/NicotinD/compare/v0.1.94...v0.1.95) (2026-06-20)


### Features

* **spotify:** metadata fallback lane with download via spotDL ([259acac](https://github.com/kevinch3/NicotinD/commit/259acac83c3df3eed18dfd091b7ef63c886d1bba))

## [0.1.94](https://github.com/kevinch3/NicotinD/compare/v0.1.93...v0.1.94) (2026-06-18)

## [0.1.93](https://github.com/kevinch3/NicotinD/compare/v0.1.92...v0.1.93) (2026-06-18)


### Bug Fixes

* **web:** truncate long download titles instead of stretching the row ([fc506d6](https://github.com/kevinch3/NicotinD/commit/fc506d6b42bc515d85bba94d2576565f5a8347a6))

## [0.1.92](https://github.com/kevinch3/NicotinD/compare/v0.1.91...v0.1.92) (2026-06-18)

## [0.1.91](https://github.com/kevinch3/NicotinD/compare/v0.1.90...v0.1.91) (2026-06-18)


### Features

* **mobile:** iOS Now Playing card via native MPNowPlayingInfoCenter plugin ([b149d5d](https://github.com/kevinch3/NicotinD/commit/b149d5d9bd34120e238ef55ed73e4d386478a2f4))


### Bug Fixes

* **web:** mobile two-column player, iOS notch safe-area, contained download rows ([b98259c](https://github.com/kevinch3/NicotinD/commit/b98259c18a7926213cf7f1b525d4f166e1ec2830))

## [0.1.90](https://github.com/kevinch3/NicotinD/compare/v0.1.89...v0.1.90) (2026-06-18)


### Features

* **mobile:** brand native app icon and splash with the NicotinD mark ([a765978](https://github.com/kevinch3/NicotinD/commit/a7659781a897470f11469e2cfea2ae2952e643a4))


### Bug Fixes

* **api:** make transcoded streams seekable via a disk cache ([600f763](https://github.com/kevinch3/NicotinD/commit/600f76371fe1099cccb22a0345673de4f4f965b6))
* **web:** disable double-tap zoom and wire the mini-player grab hatch ([468c313](https://github.com/kevinch3/NicotinD/commit/468c3132ac297093f4791b8e31540543a45bc76d))

## [0.1.89](https://github.com/kevinch3/NicotinD/compare/v0.1.88...v0.1.89) (2026-06-18)


### Features

* **api:** tighten archive.org lane and show track count / album-single ([82765e7](https://github.com/kevinch3/NicotinD/commit/82765e770df51fc1e8a9603013fdb1bde2a8d8fb))
* **web:** raw-network fallback when an album isn't in Lidarr discography ([9df6246](https://github.com/kevinch3/NicotinD/commit/9df62467b05f75369bf6b42f5021978f81c75f0e))
* **web:** resolve artist link by name for network-played tracks ([ae52cc1](https://github.com/kevinch3/NicotinD/commit/ae52cc1cd0b9fbce26fcbdfef9f679b58bde9018))


### Bug Fixes

* **metadata:** drop placeholder artist from the fix/optimize query ([3915a8d](https://github.com/kevinch3/NicotinD/commit/3915a8d5c5bc98bb9cd58d18db880b4a9eeb672a))

## [0.1.88](https://github.com/kevinch3/NicotinD/compare/v0.1.87...v0.1.88) (2026-06-17)


### Features

* **mobile:** add iOS app build (Capacitor) + feasibility assessment ([49b0185](https://github.com/kevinch3/NicotinD/commit/49b01856a3c0f6fcf5daa2745be666aa30c37f1a))

## [0.1.87](https://github.com/kevinch3/NicotinD/compare/v0.1.86...v0.1.87) (2026-06-17)


### Bug Fixes

* **web:** artist link resolves to artist page from search-played tracks ([3c71309](https://github.com/kevinch3/NicotinD/commit/3c71309b4723b6bde11fe2e37cdfcd6ee25a791b))

## [0.1.86](https://github.com/kevinch3/NicotinD/compare/v0.1.85...v0.1.86) (2026-06-17)


### Features

* **mobile:** system playback controls + background audio ([9adc65b](https://github.com/kevinch3/NicotinD/commit/9adc65b584fc92b6bc808521fe6416c7aec5b9b8))


### Bug Fixes

* **web:** button/heading contrast on light themes ([4990830](https://github.com/kevinch3/NicotinD/commit/4990830fecac5c5e28980db0a6d9121eb3db1391))

## [0.1.85](https://github.com/kevinch3/NicotinD/compare/v0.1.84...v0.1.85) (2026-06-17)


### Bug Fixes

* **mobile:** resolve gradle versionCode parsing (space-before-paren) ([8e3f238](https://github.com/kevinch3/NicotinD/commit/8e3f23841e947ee8206d1bd766f8b2775a189cdc))

## [0.1.84](https://github.com/kevinch3/NicotinD/compare/v0.1.83...v0.1.84) (2026-06-17)


### Features

* **mobile:** android app via Capacitor wrap of the web UI ([6d6243d](https://github.com/kevinch3/NicotinD/commit/6d6243d61bef6da2fd4cdd48a4ceabf177a90d4d))

## [0.1.83](https://github.com/kevinch3/NicotinD/compare/v0.1.82...v0.1.83) (2026-06-17)


### Bug Fixes

* **archive:** improve archive.org lane precision (exclude non-music, sort by popularity, dedupe) ([b6253df](https://github.com/kevinch3/NicotinD/commit/b6253df56e05cc024363678f909ae810e5128ec9))

## [0.1.82](https://github.com/kevinch3/NicotinD/compare/v0.1.81...v0.1.82) (2026-06-15)


### Features

* **library:** user-driven metadata fix (correct artist/album, confirm candidates) ([5b4b24e](https://github.com/kevinch3/NicotinD/commit/5b4b24e919f1dfcf6732c31c9c483f72ecdac1d7))

## [0.1.81](https://github.com/kevinch3/NicotinD/compare/v0.1.80...v0.1.81) (2026-06-15)


### Bug Fixes

* **web:** keep mini-player controls in a deterministic position ([d0b3fd8](https://github.com/kevinch3/NicotinD/commit/d0b3fd81c458f94021639038ff6c2691f69c8c81))

## [0.1.80](https://github.com/kevinch3/NicotinD/compare/v0.1.79...v0.1.80) (2026-06-15)

## [0.1.79](https://github.com/kevinch3/NicotinD/compare/v0.1.78...v0.1.79) (2026-06-15)


### Features

* **catalog:** load artist discography on demand (A6 deep fix) ([2284483](https://github.com/kevinch3/NicotinD/commit/2284483c39fc5b3f20b28e5ea24c3154ebc3529f))
* **hunt:** per-track hunter as the album-hunt 0-candidate fallback (C1, F2) ([798f151](https://github.com/kevinch3/NicotinD/commit/798f15157e653ccfb27eb0ddcff1d1946888740e))


### Bug Fixes

* **web:** dedupe near-identical network folders across peers (A7) ([4e86a78](https://github.com/kevinch3/NicotinD/commit/4e86a78c1cbcf0581779faa8f6d57e05c3dc8db5))
* **web:** show peer-response progress during network search (C2); assess C3 ([f71afcb](https://github.com/kevinch3/NicotinD/commit/f71afcb3f1ff1a3648ea45dbcfe24278a39a9418))

## [0.1.78](https://github.com/kevinch3/NicotinD/compare/v0.1.77...v0.1.78) (2026-06-15)


### Bug Fixes

* **web:** add visible Track-info button on Now Playing (G4) ([3ce9eda](https://github.com/kevinch3/NicotinD/commit/3ce9eda64fee7523fdb1ac88cf52ab209f02a2ef))
* **web:** clamp track context menu to the viewport (G6) ([a8ace46](https://github.com/kevinch3/NicotinD/commit/a8ace4677b262fe12ba4c2eb6d37e63a873d8aa2))
* **web:** label the library album count + de-crowd mode tabs (G7) ([b83446f](https://github.com/kevinch3/NicotinD/commit/b83446f81f547e8c67eeb696527e71e225d61538))

## [0.1.77](https://github.com/kevinch3/NicotinD/compare/v0.1.76...v0.1.77) (2026-06-15)


### Bug Fixes

* **catalog:** suppress junk album cards for a matched artist, guide to network (A6) ([e49b973](https://github.com/kevinch3/NicotinD/commit/e49b9738084e966a7f662f835eca92d95821b07f))
* **web:** album-detail action row wraps so primary Play isn't clipped (G1) ([48bddc5](https://github.com/kevinch3/NicotinD/commit/48bddc56a6d396256885e803f8e8e498c795491d))
* **web:** now-playing covers use app-cover-art fallback, not broken imgs (G2) ([eba93cd](https://github.com/kevinch3/NicotinD/commit/eba93cd47d7a46d6c14600ab0821e446125e401d))
* **web:** rank network folders + surface format, fix "Unknown bitrate" (A7) ([90a6cad](https://github.com/kevinch3/NicotinD/commit/90a6cad9d5fd2c60d4abaa9ebd7a3cba669e2bd2))
* **web:** track-info sheet shows song identity header (G3) ([1a2279a](https://github.com/kevinch3/NicotinD/commit/1a2279a4570537c85e63d922d39a8f613f0b3416))

## [0.1.76](https://github.com/kevinch3/NicotinD/compare/v0.1.75...v0.1.76) (2026-06-14)


### Features

* **library:** audio standardization, track analysis & metadata optimization ([13aa660](https://github.com/kevinch3/NicotinD/commit/13aa6607dccd750839d5c5afe16d8a5c7ca465f9))


### Bug Fixes

* **acquire:** spotdl progress never advances + premature done state ([e6f30d9](https://github.com/kevinch3/NicotinD/commit/e6f30d908b0e51d3ab1238acc2bfba0903361abb))
* **web:** native-range seek bar, e-ink legibility, branded favicon ([793458f](https://github.com/kevinch3/NicotinD/commit/793458f2d46ba282ff3eecb5ce6a8e0ab3efabcc))

## [0.1.75](https://github.com/kevinch3/NicotinD/compare/v0.1.74...v0.1.75) (2026-06-14)


### Bug Fixes

* **library:** stop duplicated albums in grid during active downloads ([e49f190](https://github.com/kevinch3/NicotinD/commit/e49f1902b27ed7c549e8028898e46d3713761eca))

## [0.1.74](https://github.com/kevinch3/NicotinD/compare/v0.1.73...v0.1.74) (2026-06-14)


### Features

* **downloads:** unified Active feed with method, stage, timing and storage path ([d3111b5](https://github.com/kevinch3/NicotinD/commit/d3111b5565be7d89890e3de6c4d2be9060c6c3d2))
* **search:** demote raw network search behind Advanced, simplify acquire UX ([ef6287d](https://github.com/kevinch3/NicotinD/commit/ef6287db877d52c34be541b07f1544ab8315a6c2))

## [0.1.73](https://github.com/kevinch3/NicotinD/compare/v0.1.72...v0.1.73) (2026-06-14)


### Features

* **acquisition:** track per-file provenance + pipeline stages, surface on tracks ([62a313c](https://github.com/kevinch3/NicotinD/commit/62a313c93cf5c71948d3813cf134d5917c4a62ed))

## [0.1.72](https://github.com/kevinch3/NicotinD/compare/v0.1.71...v0.1.72) (2026-06-14)


### Features

* **web:** song-first 'Songs' lane for network search ([b393984](https://github.com/kevinch3/NicotinD/commit/b3939840c35ad58a4582b4344bac9ea09bdd1948))

## [0.1.71](https://github.com/kevinch3/NicotinD/compare/v0.1.70...v0.1.71) (2026-06-14)


### Bug Fixes

* **web:** surface the server's reason when album-hunt prep fails ([d3ec578](https://github.com/kevinch3/NicotinD/commit/d3ec578481c99b291957e732e0af737d0cb57df0))

## [0.1.70](https://github.com/kevinch3/NicotinD/compare/v0.1.69...v0.1.70) (2026-06-13)


### Bug Fixes

* **acquire:** ingest downloaded tracks on non-zero yt-dlp exit ([1dc8a02](https://github.com/kevinch3/NicotinD/commit/1dc8a02b336f6a8bf36ee320b60154dc94ceac39))

## [0.1.69](https://github.com/kevinch3/NicotinD/compare/v0.1.68...v0.1.69) (2026-06-13)


### Bug Fixes

* **acquire:** keep partly-unavailable playlists instead of failing whole job ([5e0fcfa](https://github.com/kevinch3/NicotinD/commit/5e0fcfa7dedbf9524fcdd32c98f457e319eb2b78))

## [0.1.68](https://github.com/kevinch3/NicotinD/compare/v0.1.67...v0.1.68) (2026-06-13)


### Features

* **acquire:** show playlist name as acquire job label ([265535f](https://github.com/kevinch3/NicotinD/commit/265535f7b3f818393e330afdaa8246ed1c8ae85d))

## [0.1.67](https://github.com/kevinch3/NicotinD/compare/v0.1.66...v0.1.67) (2026-06-13)


### Bug Fixes

* **plugins:** register specific-URL plugins before yt-dlp catch-all ([4a997ba](https://github.com/kevinch3/NicotinD/commit/4a997ba6d8c64f2a35bc31f0f6c2559b99af6601))

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
