# NicotinD Usage Analysis

**Date:** 2026-06-01  
**Data sources:** `nicotind.db` (SQLite), `journalctl --user`, `repair-album-dupes.log`, `reorg-moves.log`, `normalize-moves.log`

---

## Library Scale

| Metric | Value |
|--------|-------|
| Artists | 3,288 |
| Albums | 4,216 |
| Songs | 9,556 |
| Completed download records | 4,055 |
| Albums tombstoned (deleted) | 45 (pre-analysis) |
| Transfer retries logged | 143 |

---

## Download Activity Over Time

| Month | Tracks |
|-------|--------|
| 2026-03 | 374 |
| 2026-04 | 1,639 |
| 2026-05 | 883 |
| 2026-06 | 1,159+ (in progress) |

April spike corresponds to full adoption of the catalog/album-hunt flow.

---

## Music Taste Profile

### Primary: Latin American

**Argentine Rock (Rock Nacional)**

| Artist | Tracks | Notes |
|--------|--------|-------|
| Patricio Rey y sus Redonditos de Ricota | 132 | Gulp, Oktubre |
| La Renga | 129 | Truenotierra |
| Babasónicos | 97 | |
| Bersuit Vergarabat | 73 | |
| Soda Stereo | 72 | Canción Animal, Sueño Stereo |
| Almafuerte | 52 | A Fondo Blanco (FLAC) |
| Attaque 77 | 27 | |
| Catupecu Machu, Los Fabulosos Cadillacs | present | |

**Argentine Cumbia / Cuarteto / Folklore**

La Mona Jimenez, Los Nocheros, Damas Gratis, La Konga, Gilda, Banda XXI, La Barra, Los Palmeras, Los Nota Lokos, Rodrigo, Tru La La, Sabroso, Mercedes Sosa

**Argentine Reggae**

| Artist | Tracks |
|--------|--------|
| Los Cafres | 116 (Barrilete, Suena la alarma — FLAC) |
| Cultura Profética | 49 |
| Dread Mar-I | 53 |

**Reggaeton / Urbano Latino**

| Artist | Tracks | Notes |
|--------|--------|-------|
| Bad Bunny | 93 | YHLQMDLG, DeBÍ TiRAR MáS FOToS, LAS QUE NO IBAN A SALIR — all FLAC |
| Calle 13 / Residente | 98 | |
| Daddy Yankee | 61 | |
| Wisin & Yandel | 48 | |
| J Balvin | 29 | |
| KAROL G | 25 | |
| Nathy Peluso | 35 | |
| IPAUTA / compilations | 117 | Mas Flow era |
| Vico C, Nando Boom | present | Early reggaeton |

**Latin Pop / Spanish-language**

| Artist | Tracks |
|--------|--------|
| Shakira | 109 |
| Vilma Palma E Vampiros | 77 |
| Rawayana | 83 (Venezuelan) |
| Maná | 84 |
| Ricky Martin | 57 |
| Ricardo Arjona | 56 |
| La Oreja de Van Gogh | 53 |
| Jarabe de Palo | 51 |
| Gustavo Cerati | 49 |
| Charly García | 49 |
| Miranda! | 57 |
| Raffaella Carrà | 77 |
| Juana Molina | 26 |
| Thalía, Fabiana Cantilo, Paulina Rubio, Zaz | present |

**Chilean**

Joe Vasconcellos (46 tracks), Los Tres (9)

---

### Secondary: Classic Rock / International

| Artist | Tracks | Notes |
|--------|--------|-------|
| Pink Floyd | 216 | The Division Bell (standard + high-res), Wish You Were Here (FLAC) |
| ABBA | 163 | Super Trouper, Ring Ring, Voyage (Japan Ltd FLAC), Waterloo |
| Bob Marley & The Wailers | 139 | Multiple albums |
| Lenny Kravitz | 104 | Are You Gonna Go My Way (FLAC), Circus, Lenny |
| Tame Impala | 52 | |
| Limp Bizkit | 56 | |
| Black Eyed Peas | 57 | |
| Backstreet Boys | 52 | |
| Madonna | 54 | |
| Eminem | 22 | |
| Gorillaz | 29 | |
| The Beatles | 24 | |

---

### Tertiary: Electronic / Dance

| Artist / Source | Tracks |
|-----------------|--------|
| Daft Punk | 45 |
| Beatport Top 100 Melodic House & Techno April 2022 | ~100 |
| beatport best of tech house 2026 | 67 |
| David Guetta | 67 |
| The Chemical Brothers, Jamiroquai | ~24 each |

---

## Download Patterns

### Album-first

The album hunt (catalog → Lidarr → slskd) is the primary acquisition path.

**Album job outcomes (57 total):**

| State | Count | % |
|-------|-------|---|
| done | 19 | 33% |
| exhausted | 38 | 67% |

30 of 57 jobs (53%) hit the max 3 fallback attempts. Latin American albums are particularly hard to source complete copies of from Soulseek peers.

### Format preference

| Format | Count | % |
|--------|-------|---|
| null (pre-organizer / raw downloads) | 2,226 | 55% |
| MP3 | 915 | 23% |
| FLAC | 715 | 18% |
| m4a | 61 | 1.5% |

When using album hunt, user prefers FLAC when available (Bad Bunny, Lenny Kravitz, Pink Floyd, Los Cafres all went FLAC).

The 2,226 null-path entries are individual file downloads predating the library organizer — they exist on disk but NicotinD has no `relative_path` record for them.

### Top Soulseek peers

- Generic `music/Music/MUSICA` folders — standard P2P layout
- `@@hrptu` — Rock Nacional 100% Clásicos compilation (~194 tracks)
- `@@ggkig` — Pink Floyd
- `Emepetreses` — Limp Bizkit, Don Omar archives
- `MP3's Rodrigo` — Ricardo Arjona discography
- `Beatport` — electronic

---

## Errors and Technical Issues

### 1. Navidrome crash on startup (code 2, first two attempts)

Seen 2026-05-10. Navidrome exited with code 2 immediately on the first two attempts; NicotinD timed out on health check and restarted, succeeding on the 3rd try. Likely a port-binding race or lock file from unclean shutdown. Results in ~90s unavailability.

### 2. Album fallback exhaustion rate: 67%

Most album hunt jobs hit 3 fallback attempts without completing. Worst-affected: Patricio Rey y sus Redonditos de Ricota, La Oreja de Van Gogh, Joe Vasconcellos, Vilma Palma e Vampiros, Soda Stereo, Raffaella Carrà, Bad Bunny.

### 3. Duplicate file accumulation (resolved in 0.1.33)

`repair-album-dupes.log` shows 130 tracks cleaned up, concentrated in Bad Bunny *DeBÍ TiRAR MáS FOToS* (up to 4 copies per track) and Lenny Kravitz (mixed MP3 + FLAC copies). Root cause was the fallback targeting Lidarr's bloated deluxe tracklist instead of the primary folder's manifest — fixed in commit `8e8cc3d`.

### 4. 2,226 tracks with null relative_path

More than half of all completed_downloads lack a `relative_path`, meaning they were never routed through `LibraryOrganizer`. These tracks exist on disk but are invisible to auto-playlist, album deletion, and tombstoning logic.

### 5. High memory usage

954.9 MB peak RSS for a 19-hour systemd session (pre-Docker migration). Embedded mode (slskd + Navidrome + bun) is memory-hungry.

---

## User Profile Summary

1. **Latin American music specialist** — library is weighted toward Argentine rock, cumbia/cuarteto, reggae, reggaeton, and Latin pop. Almost certainly based in Argentina or Southern Cone.
2. **Album-oriented** — uses catalog/hunt as the primary acquisition path; wants complete albums.
3. **FLAC-preferring** for new acquisitions; older downloads are MP3.
4. **Active curator** — ran reorg, normalize, and repair-dupes scripts manually; tombstoned 45 albums.
5. **Growing fast** — 0 → 9,556 tracks in ~3 months; April 2026 was a 4× spike.

---

## Feature Gaps Identified

| Observation | Potential feature |
|-------------|-------------------|
| 67% album job exhaustion rate | Show "incomplete" status with missing tracks; allow retry with custom query |
| 2,226 tracks with no `relative_path` | Retroactive path assignment / "Untracked downloads" view |
| Mixed MP3+FLAC duplicates | Format preference setting: skip MP3 if FLAC already exists |
| Beatport compilation downloads | Better compilation/playlist support for non-album acquisitions |
| `repair-album-dupes` run manually | Automatic post-download deduplication |
| Navidrome code-2 crash on restart | Smarter restart: detect stale lock, retry before failing hard |
| Cumbia/cuarteto poorly tagged | Genre-aware search hints (these genres are underrepresented on MusicBrainz/Lidarr) |
