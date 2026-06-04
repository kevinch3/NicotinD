/** The known URL-acquisition backends. */
export type AcquireBackend = 'ytdlp' | 'spotdl';
export type AcquireJobState = 'queued' | 'running' | 'done' | 'failed';

export interface AcquireJob {
  id: string;
  /** Id of the acquisition plugin that ran the job (e.g. 'ytdlp', 'spotdl'). */
  backend: string;
  url: string;
  label: string | null;
  state: AcquireJobState;
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
}
