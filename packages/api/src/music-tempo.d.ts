// Minimal ambient types for the untyped `music-tempo` package (no @types).
// Only the surface we use: construct with PCM samples, read `.tempo`.
declare module 'music-tempo' {
  export default class MusicTempo {
    constructor(audioData: Float32Array | number[], params?: Record<string, number>);
    tempo: number;
    beats: number[];
  }
}
