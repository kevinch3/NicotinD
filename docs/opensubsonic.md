# OpenSubsonic API

NicotinD answers the [OpenSubsonic](https://opensubsonic.netlify.app/) API at `/rest/*`, so
Music Assistant (its OpenSubsonic provider) and any Subsonic app (Symfonium, Feishin, DSub,
Supersonic…) can use the library as a music server: browse, search, stream, star, playlists and
scrobbles.

This reverses one line of [library-ux-restructure.md](library-ux-restructure.md), which retired the
Navidrome `/rest/*` proxy because nobody used a Subsonic client. Music Assistant is the reason it
came back. What came back is a native implementation, not the proxy.

## Connecting an app

1. **Settings → Subsonic apps → New key.** Name it after the app. The key (`nss_…`) is shown once.
2. In the app, set the server URL to NicotinD's address (the page shows it), the username to yours,
   and the key as the **API key**, or as the **password** in apps that do not know API keys.
3. **Music Assistant:** add the *OpenSubsonic* music provider and paste the key into its API key
   field. Leave "legacy authentication" off.

Revoking a key on the same page signs that app out immediately.

## Design: a translator over `/api`, not a second library

`routes/opensubsonic.ts` queries no library table. Every method calls NicotinD's own `/api` routes
in-process as the key's owner (`internalUpstream` mints a short-lived session JWT and runs the
request through `app.fetch`), then reshapes the JSON (`services/opensubsonic-map.ts`) into
Subsonic's envelope (`services/opensubsonic-response.ts`).

Why: the web app's routes already carry the auth middleware, the role ladder, hidden/in-flight
album suppression, the feed-eligibility predicate, multi-artist credits and the Range-capable,
transcode-cached stream. A second set of SQL for Subsonic would have to re-derive every one of those
and would drift. In-process calls cost a JSON round-trip per request, which is small next to the
SQLite work behind it.

The only state this layer owns is its own:

| Table | Holds |
| --- | --- |
| `subsonic_api_keys` | sha256 of each key, its owner, name, `last_used_at` (touched at most once a minute) |
| `user_starred_items` | per-user **album** and **artist** stars |

A **song** star is a like: `star`/`unstar` on a song id calls the like routes, so it appears in Liked
Songs in the web app and vice versa. `getStarred2` reads both stores.

## Authentication

Subsonic's usual `t=md5(password+salt)` token auth needs the server to keep the plaintext password.
NicotinD stores only password hashes, so it cannot support token auth, and it does not keep a
second plaintext copy to make it work. Instead:

- `apiKey=<key>` is the OpenSubsonic `apiKeyAuthentication` extension and the preferred way.
- `u=<user>&p=<key>` (plain, or `enc:`-hex) is accepted for legacy clients, with the key standing in
  as the password. It must belong to `u`.
- `u=&t=&s=` returns error **41** with a message pointing at API keys.
- `apiKey` together with `u` returns **43**, an unknown key **44**, a key that does not belong to
  `u` **40**, and no credentials **10**.

A key acts as its owner with the owner's **current** role. The role is read on every call, and the
cached internal session is re-minted when it changes. A disabled account's keys stop working.
`getOpenSubsonicExtensions` is the one method served without auth, as the spec requires.

## Responses

XML by default and JSON with `f=json`, built from one payload object: scalars become attributes,
arrays repeated elements, and a `value` field the element's text. Errors are HTTP 200 with
`status="failed"` and a Subsonic error code. That includes an unknown method (**70**), so a client
degrades instead of hitting a 404 page. Parameters may also come as a form POST (`formPost`
extension). The `.view` suffix older clients add is accepted.

## Methods

| Area | Methods | Backed by |
| --- | --- | --- |
| System | `ping` `getLicense` `getOpenSubsonicExtensions` `getUser` `getMusicFolders` `getScanStatus` | — |
| Browse | `getArtists` `getIndexes` `getArtist` `getAlbum` `getSong` `getMusicDirectory` `getGenres` `getArtistInfo(2)` `getAlbumInfo(2)` | `/api/library/artists`, `/albums/:id`, `/songs/:id`, `/genres` |
| Lists | `getAlbumList(2)` `getRandomSongs` `getSongsByGenre` `getStarred(2)` | `/api/library/albums?classification=any`, `/random`, `/genres/songs` |
| Search | `search2` `search3` | `LibrarySearchProvider`; an empty query pages `/api/library/songs` |
| Media | `stream` `download` `getCoverArt` `getLyricsBySongId` `getLyrics` | `/api/stream/:id`, `/api/cover/:id`, `/songs/:id/lyrics` |
| User data | `star` `unstar` `scrobble` `getPlaylists` `getPlaylist` `createPlaylist` `updatePlaylist` `deletePlaylist` | likes, `user_starred_items`, `/api/history/plays`, `/api/playlists` |
| Discovery | `getSimilarSongs(2)` `getTopSongs` | `/songs/:id/similar`, `popularity` |
| Empty by design | `getNowPlaying` `getInternetRadioStations` `getPodcasts` `getNewestPodcasts` `getBookmarks` `getPlayQueue` `getShares` | — |

### Mapping notes

- **Albums of every release type.** The web grid shows full-length albums only and puts singles and
  EPs on the artist page. Subsonic has no such split, so the album lists ask for
  `classification=any`. `releaseTypes` and `isCompilation` carry the type.
- **Library enumeration.** Music Assistant syncs by paging `search3` with an empty query. The song
  pages walk `/api/library/songs?sort=album`, and every song order ends on `s.id`
  (`songOrderBy`), so a tie never repeats or skips a row between pages.
- **Text search** goes to the same `LibrarySearchProvider` as the web search box, never the network
  lane, so a Subsonic search can never start a Soulseek query. It is capped at 10 artists, 20
  albums and 40 songs per query. Its album rows are slim, so the hits are re-read whole through
  `/api/library/albums/:id`.
- **Required fields are always present.** py-opensonic, the client library inside Music
  Assistant's provider, validates every response against the schema and rejects a whole result
  over one bad item. An album with no parseable date therefore reports `created` as the epoch
  rather than omitting it. That is how text search first failed against it.
- **`recent` / `frequent` / `highest`** album lists answer with the newest albums. Per-user play
  counts and ratings are not behind the album grid yet.
- **Scrobbles** become `play_events` with `source='subsonic'` and a deterministic `clientEventId`
  (`subsonic:<user>:<song>:<time>`), so a client that retries a scrobble does not double count.
  `submission=false` (now playing) is ignored. The user's history-collection consent still applies,
  because the call goes through `/api/history/plays`.
- **`stream`** forwards `format` and `maxBitRate` to `/api/stream/:id`, so the admin streaming
  settings apply exactly as for the web player, and `format=raw` asks for the original. `Range`
  and `If-Range` pass through, so seeking works.
- **IDs** are NicotinD's own. An album id is derived from the album's name, so a rename re-mints it
  and a client that caches ids (Music Assistant does) sees the old album disappear and a new one
  appear on its next sync.

## Verifying against a real client

The route tests run every method over the real `/api` routes. Before changing the response shapes,
also drive a throwaway server (`NICOTIND_PORT`, `NICOTIND_DATA_DIR`, `NICOTIND_MUSIC_DIR` pointed
at a copy of `packages/e2e/fixtures/music`) with `py-opensonic`, using both `use_get=True` (what
Music Assistant does with an API key) and the default form POST. Its schema validation catches
missing required fields that a JSON assertion does not.

## Not supported

Token (md5) authentication, jukebox, podcasts, internet radio, shares, bookmarks and play queues,
video, user management, and `startScan` (it is not mapped: scanning stays an admin action in the web
app).
