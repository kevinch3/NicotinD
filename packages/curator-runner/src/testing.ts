import type { McpLike, ToolResult } from './mcp-client.js';
import type { ClassifyPrompt, GenreModel, Verdict } from './model.js';

/**
 * Test doubles: an in-memory MCP server holding just enough library to drive a
 * run, and a scripted model. The fake server mirrors the real one's auto-scope
 * policy for `set_song_genre` (fill-only, vocabulary-only, budget) so a test
 * asserting "the runner never writes X" cannot pass merely because the fake was
 * more permissive than production.
 */
export interface FakeSong {
  id: string;
  title: string;
  artist: string;
  genres: string[];
}

export interface FakeAlbum {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  songs: FakeSong[];
}

const CATCH_ALL = new Set(['electronic', 'dance']);

export class FakeMcp implements McpLike {
  scope = 'refiner:auto';
  vocabulary = ['Tech House', 'Techno', 'Reggae'];
  albums = new Map<string, FakeAlbum>();
  artists: Array<{ id: string; name: string; country: string | null; albumIds: string[] }> = [];
  /** Artist ids on the catch-all worklist. */
  lowInformationArtists: string[] = [];
  recentLandings: number[] = [];
  genreBudget = Infinity;
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  flags: Array<Record<string, unknown>> = [];

  async initialize(): Promise<string> {
    return `You are connected to a NicotinD music library as a refiner (curation, no server admin). Scope: ${this.scope}.`;
  }

  private songs(): FakeSong[] {
    return [...this.albums.values()].flatMap((a) => a.songs);
  }

  private metrics() {
    const songs = this.songs();
    return {
      lowInformation: songs.filter(
        (s) => s.genres.length === 1 && CATCH_ALL.has(s.genres[0]!.toLowerCase()),
      ).length,
      missing: songs.filter((s) => s.genres.length === 0).length,
    };
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const ok = (v: unknown): ToolResult => ({ ok: true, text: JSON.stringify(v) });
    const refuse = (text: string): ToolResult => ({ ok: false, text });
    switch (name) {
      case 'get_library_health':
        return ok({
          dimensions: {
            genres: {
              metric: { songs: this.songs().length, ...this.metrics() },
              lowInformationWorklist: this.lowInformationArtists.map((id) => ({
                artistId: id,
                artist: this.artists.find((a) => a.id === id)?.name ?? id,
                genre: 'Electronic',
                songs: 1,
              })),
            },
          },
        });
      case 'list_genre_vocabulary':
        return ok({ genres: this.vocabulary });
      case 'list_recent_songs': {
        if (args.missingGenre === true) {
          const rows = [...this.albums.values()].flatMap((a) =>
            a.songs.filter((s) => s.genres.length === 0).map((s) => ({ id: s.id, albumId: a.id })),
          );
          return ok({ songs: rows });
        }
        return ok({ songs: this.recentLandings.map((t, i) => ({ id: `r${i}`, landedAt: t })) });
      }
      case 'get_artist': {
        const a = this.artists.find((x) => x.id === args.id);
        if (!a) return ok({ error: 'artist not found' });
        return ok({
          id: a.id,
          name: a.name,
          origin: a.country ? { country: a.country } : null,
          mbid: null,
          albums: a.albumIds.map((id) => {
            const al = this.albums.get(id)!;
            return { id, name: al.name, year: al.year, genre: al.songs[0]?.genres[0] ?? null };
          }),
        });
      }
      case 'search_library':
        return ok({
          artists: this.artists
            .filter((a) => a.name.toLowerCase().includes(String(args.query).toLowerCase()))
            .map((a) => ({ id: a.id, name: a.name })),
          albums: [],
          songs: [],
        });
      case 'get_album_tracks': {
        const al = this.albums.get(String(args.id));
        if (!al) return ok({ album: null, songs: [] });
        return ok({
          album: { id: al.id, name: al.name, artist: al.artist, year: al.year },
          songs: al.songs.map((s) => ({ ...s, genre: s.genres[0] ?? null })),
        });
      }
      case 'set_song_genre': {
        if (this.scope !== 'refiner:auto') return refuse('test fake only models the auto scope');
        if (this.genreBudget <= 0) return refuse('Daily budget exhausted: 200/200. Stop the run.');
        if (args.mode !== 'replace') return refuse('must pass mode: "replace"');
        const song = this.songs().find((s) => s.id === args.songId);
        if (!song) return refuse('Song not found');
        const real = song.genres;
        if (!(real.length === 0 || (real.length === 1 && CATCH_ALL.has(real[0]!.toLowerCase())))) {
          return refuse('Song already has a specific genre');
        }
        if (!this.vocabulary.includes(String(args.genre))) {
          return refuse("Not in the library's genre vocabulary");
        }
        this.genreBudget--;
        song.genres = [String(args.genre)];
        return ok({ ok: true, genres: song.genres });
      }
      case 'flag_for_review':
        this.flags.push(args);
        return ok({ id: this.flags.length, servedToHuman: true });
      default:
        return refuse(`fake MCP does not implement ${name}`);
    }
  }

  writes(): string[] {
    return this.calls.filter((c) => c.name === 'set_song_genre').map((c) => String(c.args.songId));
  }
}

/** A model that answers from a script, cycling; records every prompt it saw. */
export class ScriptedModel implements GenreModel {
  prompts: ClassifyPrompt[] = [];
  private i = 0;
  constructor(private readonly script: Array<Verdict | Error>) {}
  async classify(prompt: ClassifyPrompt): Promise<Verdict> {
    this.prompts.push(prompt);
    const next = this.script[this.i++ % this.script.length]!;
    if (next instanceof Error) throw next;
    return next;
  }
}

export const verdict = (genre: string, confidence: 'high' | 'low' = 'high'): Verdict => ({
  genre,
  confidence,
  evidence: 'test',
});
