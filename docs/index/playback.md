# Playback, radio & streaming

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Recommendation strategies**: named recipes (weights, artist cap, pool mix, out-of-genre quota)
  chosen by `?strategy=` and stamped on poll scenarios; the Now Playing chip's variety control maps
  complaints to remedies in one core function. `STRATEGIES`, `resolveStrategy`,
  `strategyForVariety`, `radio-variety`. → [radio.md](../radio.md)
- **Radio provenance**: the queue reports the formula version, the genre axis that actually ran
  (`learned` only when a centroid covered it; `station` for a filter radio) and the strategy, behind
  an opt-in `?provenance=1` envelope so an installed client still parses the bare array.
  `RadioProvenance`, `radioProvenance`, `radioBody`, `radio-chip-provenance`. → [radio.md](../radio.md)
- **Per-user exclusions**: "Don't recommend this" holds a song out of every feed for one listener
  without touching the library; explicit votes and a derived early-skip rule (`SKIP_RULE`) feed the
  `excludeIds` layer at request time, twin recordings included. `recordFeedback`, `excludedSongIds`,
  `RecommendationExclusionsService`. → [radio.md](../radio.md)
- **Feed eligibility**: one predicate decides whether a song may be *recommended* (hidden song or
  album, landed, duration floor, analysed-or-permanently-failed at tier 1 with a tier-2 fallback when
  a feed starves); every feed uses it and `check:feed-eligibility` fails a feed that does not.
  `feedEligibilitySql`, `isFeedEligible`, `POOL_FLOOR`. → [radio.md](../radio.md)
- **Native streaming + cover art**: `GET /api/stream/:id` (Range/206 + seekable transcode cache) and
  `GET /api/cover/:id`; `GET /api/cover/remote` proxies catalog covers through the same downscale
  path, host-allowlisted and content-addressed. `nativeAppCors` is hand-rolled so its Vary append
  cannot strip `Content-Length`. → [library-scanner.md](../library-scanner.md),
  [album-hunt.md](../album-hunt.md)
- **RFC 9110-complete range handling**: `serveFileWithRange` serves suffix ranges (`bytes=-N` = the
  *last* N bytes) correctly — returning the head under a mismatched Content-Range stalls iOS Safari's
  tail-probing media loader forever. → [library-scanner.md](../library-scanner.md)
- **Transcode cache integrity**: size-in-key, size floor, ffprobe post-check, an in-use pin released
  by `schedulePinRelease` (a body wrapper made Bun emit a chunked 206 that Firefox and iOS stall on),
  and a negative cache for the deterministic `TranscodeOutputRejectedError` only.
  → [library-scanner.md](../library-scanner.md)
- **One process-wide ffmpeg cap**: every ffmpeg/ffprobe child holds a `ffmpegSlots` slot
  (`withFfmpegSlot`, `NICOTIND_FFMPEG_SLOTS`); batch keeps one free for streams and waveforms.
  → [download-pipeline.md](../download-pipeline.md)
- **Frontend false-ended recovery**: `browserDurationIsAcceptable`, `isFalseEnded`, `startRecovery`,
  `loadGeneration`, bounded by `MAX_RECOVERY_ATTEMPTS` with both gates falling back to
  `FALSE_ENDED_ABSOLUTE_FLOOR_SEC` when the known duration is missing; the valve resumes where the
  listener was, never at 0. → [web-ui.md](../web-ui.md)
- **A dead stream is reloaded, not abandoned**: a media `error` — or a stall that raises nothing at
  all — reloads the track and resumes where it stopped, bounded by `MAX_RECOVERY_ATTEMPTS`, while an
  outage holds the intent until the network returns. `recoverFromDeadStream`, `armStallWatchdog`,
  `STREAM_STALL_TIMEOUT_MS`, `holdPausedState`, `parkedGeneration`. → [web-ui.md](../web-ui.md)
- **A seek is an intent, not a poke**: a forward seek past the loaded region is held and applied once
  `audio.seekable` covers it, never assigned and silently clamped into a false `ended`.
  `pendingSeek`, `requestSeek`, `applyPendingSeek`, `seekTargetIsAvailable`,
  `PENDING_SEEK_TIMEOUT_MS`. → [web-ui.md](../web-ui.md)
- **A skip burst costs one load**: navigation stays instant while the byte-level load settles on the
  trailing edge, and every `src` change bumps the load generation rather than only element swaps.
  `LOAD_SETTLE_MS`, `assignSource`, `playIfIntended`. → [web-ui.md](../web-ui.md)
- **Playback loading feedback (HDD-aware)**: one `buffering` signal (delayed `bufferingVisible`)
  drives spinners, row indicators and the buffered band; every stream URL goes through `streamUrl()`,
  which appends `ngsw-bypass`. Restore-on-load never autoplays — `wasPlaying` is written, not read.
  → [web-ui.md](../web-ui.md)
- **Queue management**: `PlayerService` exposes `queueNext`, `addToQueue`, `clearQueue`,
  `removeFromQueue`, `moveInQueue`, `toggleShuffle`, `jumpToQueueIndex`; the Now Playing queue adds a
  header toolbar, per-row remove, drag-reorder, a persisted drag-resize handle and history peek.
  → [song-actions.md](../song-actions.md), [web-ui.md](../web-ui.md)
- **Queue semantics — what a click replaces**: `play()` is the queue-untouched primitive,
  `playSingle()` replaces the queue for a context-less click, `playWithContext()` makes that list the
  queue, `jumpToQueueIndex()` consumes up to the tapped row, `startRadio()` clears it.
  → [web-ui.md](../web-ui.md)
- **Now Playing component split + tabbed Queue/Lyrics panel**: the shell composes seven extracted
  sub-components with a `NowPlayingPanelTabsComponent` switcher; the resize handle is shell-owned
  above the tabs, and `lg:` is two columns. → [web-ui.md](../web-ui.md)
- **Lyrics + karaoke**: `metadata` plugin kind + `lyrics` capability (LRCLIB) in `library_lyrics`
  + file tag; karaoke panel with synced highlighting, fullscreen auto-follow, and a `?vocals=off`
  mid/side mute cached as a recipe-versioned `novox` variant. Shared state: `LyricsService`,
  `KaraokeBrowseMode`, `loadCoverPalette`, `TvKaraokeComponent`.
  → [design-patterns.md](../design-patterns.md), [vocal-isolation-spike.md](../vocal-isolation-spike.md),
  [tv-ux.md](../tv-ux.md)
- **Lyrics match quality**: a source match is ranked and rejected on duration, not taken
  first-hit; a stored `matchedDurationSec` keeps a wrong take findable as `suspectMatches`, with
  uncheckable rows counted `unverified`. `LYRICS_DURATION_TOLERANCE_SEC`.
  → [design-patterns.md](../design-patterns.md)
- **Lyrics sync offset**: bad timing is corrected by a stored offset applied at render time
  (`applyLyricsOffset`), never by rewriting the LRC, so it is reversible; `parseLrc` is in core so
  `syncedBeyondDuration` parses server-side. Tools: `get_song_lyrics`, `sync_song_lyrics`.
  → [design-patterns.md](../design-patterns.md), [mcp-agent.md](../mcp-agent.md)
- **Now Playing waveform + karaoke VFX**: rendered from a precomputed artifact.
  → [audio-ml-enrichment.md](../audio-ml-enrichment.md)
- **A radio is about its anchor**: the song or list a radio was started from seeds every top-up
  and names the session; a gesture re-anchors, a radio advance never does; the exclude window is
  wide with a narrow retry. `RadioAnchor`, `radioAnchor`, `radioExcludeIds`, `RADIO_EXCLUDE_CAP`.
  → [radio.md](../radio.md)
- **A radio queue has a depth, not a batch size**: held at `radioQueueTarget` (admin-owned
  `RadioSettings.queueTarget`, default 20), refilling the shortfall rather than draining to two;
  `replenishRadio`, `radioStarvedSeed`, `isValidQueueTarget`. → [radio.md](../radio.md)
- **Smart radio (metadata-driven queue)**: `GET /api/radio/next` scores candidates by a
  weight-normalized blend of BPM, Camelot key, genre-set closeness, artist origin, year, duration,
  artist diversity, the perceptual axes and embedding cosine. `buildSeedRadio`, `scoreSimilarity`,
  `explainSimilarity`, `genreSetCloseness`, `MISSING_GENRE_FLOOR`, `recentPlayPenalty`,
  `lastPlayedByRecording`. → [radio.md](../radio.md)
- **Genre affinity (learned genre axis, default on)**: one audio centroid per genre name over the
  library's own embeddings, used by radio, similar songs and new polls unless
  `RadioSettings.genreAffinity` is off. `library_genre_centroids`, `computeGenreCentroids`,
  `explainGenrePair`, `makeGenreAffinity`, `loadGenreAffinity`, `getRadioSettings`,
  `RadioSettingsPanelComponent`. → [genre-affinity.md](../genre-affinity.md)
- **One recording is one thing**: two files of one track (album + compilation) are two
  `library_songs` rows, so radio served it twice as often; `recordingKey` collapses them in the
  served window, the pool exclusion and the recency demotion. → [radio.md](../radio.md)
- **Taste breakers (random, recency-demoted)**: the landing shelf that counterweights "Keep the
  vibe" — `TasteBreakersComponent` over `getRandomSongs`, fetching without seeds so a fresh install
  still fills, and demoting recent plays rather than excluding them. `POOL_SIZE`, `SHELF_SIZE`.
  → [radio.md](../radio.md)
- **Home view switch**: the `''` route is a `HomeComponent` shell that lazy-loads only the view the
  user chose (`HOME_VIEW_LOADERS`, `homeViewOf`) — the mosaic by default or the classic shelves —
  with a `HomeViewSwitchComponent` top-left, remembered per user as `homeView`.
  → [web-ui.md](../web-ui.md)
- **Mosaic home — one surface, one verb**: the default home view is an infinite pannable tile field
  over every landing source where every tile starts a radio; pure `mosaic-tiles`/`mosaic-packing`/
  `mosaic-lens` under a pooled rAF shell. `patchSide`, `cellCount`, `visiblePlacements`,
  `SCORE_WEIGHTS`, `LANE_MIX`. The shelf landing lives on at `/classic`. → [web-ui.md](../web-ui.md)
- **One tile, two tones**: `VibeTileComponent` renders the classic landing's vibe row and genre row
  so they cannot drift — `tone`/`wide` carry the whole difference, and the vibe gradients are fixed
  pairs, never `--theme-*`. → [web-ui.md](../web-ui.md)
- **Filter-seeded radio / stations**: the same `GET /api/radio/next` starts a vibe with no seed
  song from a `LibraryFilter` — `buildFilterRadio`, `songFilterWheres`, `stationCentroid`; a genre
  station is graded by `stationAffinity` (`genreDepthScore` × `artistGenreShares`), a demotion never
  an exclusion. → [radio.md](../radio.md),
  [radio-stations-2026-08.md](../measurements/radio-stations-2026-08.md)
- **Radio calibration + diagnostics**: `RADIO_FORMULA_VERSION` stamps every poll so votes never pool
  across formulas; `dump-radio.ts` reports per-axis breakdowns and the served-window spread;
  `evaluatePollAgreement` replays polls into per-formula AUC. → [radio.md](../radio.md)
- **Radio evaluation polls (public, admin-created)**: frozen radio scenarios behind a public
  `/poll/:token` wizard, previewed via short-lived read-only share JWTs, distilled by
  `export-radio-poll.ts`. → [radio-eval-polls.md](../radio-eval-polls.md)
- **The output picker hides when there is nothing to pick**: `canPickOutput` drops the cast button
  on a single-device setup, keeping it while the audio is elsewhere or the panel is open.
  → [remote-playback.md](../remote-playback.md)
- **Remote playback (one audible device, Spotify-Connect-style)**: per-user `PlaybackStateManager`
  broadcasts over `GET /api/ws/playback` through `createPlaybackHub`; a device that plays claims the
  output (`claimOutput`, compare-and-set), the picker moves it (`castTo`), `hasControllableSession`
  gates the transport; `activeGraceMs`, `idleReleaseMs`. → [remote-playback.md](../remote-playback.md)
- **Auto-preserve queue (PWA lock-screen resilience)**: `AutoPreserveCoordinator` keeps the next-N
  queued tracks as IndexedDB blobs so playback survives the locked-screen network throttle;
  `evictAutoLRU` never evicts user-saved tracks. `windowSize` has a one-track rung, and changing
  it never deletes — `clearAutoSaved` is its own button. → [web-ui.md](../web-ui.md)
- **The radio source belongs to no shell**: `RadioSourceService.install()` hands `PlayerService` its
  `RadioProvider` from the app initializer, because the one shell that used to own it is not the one
  a TV build mounts; `ensureRadioOn` keeps a TV endless and `playShelfSong` makes a Home song press
  a radio seed. → [tv-ux.md](../tv-ux.md)
