export type AcquireBackend = 'ytdlp' | 'spotdl';
export type AcquireJobState = 'queued' | 'running' | 'done' | 'failed';

export interface AcquireJob {
  id: string;
  backend: AcquireBackend;
  url: string;
  label: string | null;
  state: AcquireJobState;
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
}
