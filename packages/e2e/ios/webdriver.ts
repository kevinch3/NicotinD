/**
 * The handful of W3C WebDriver calls the iOS lane makes against Appium, over
 * plain `fetch`. A client library would be a dependency in the lockfile for one
 * manual CI job; the protocol is a few JSON endpoints.
 */

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class WebDriver {
  private sessionId = '';

  constructor(private readonly base: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { value: unknown };
    if (!res.ok) {
      const v = json.value as { error?: string; message?: string } | undefined;
      throw new Error(
        `${method} ${path}: ${v?.error ?? res.status}: ${v?.message?.split('\n')[0]}`,
      );
    }
    return json.value as T;
  }

  private s(path: string): string {
    return `/session/${this.sessionId}${path}`;
  }

  async start(capabilities: Record<string, unknown>): Promise<void> {
    const v = await this.call<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
    });
    this.sessionId = v.sessionId;
  }

  async quit(): Promise<void> {
    if (this.sessionId) await this.call('DELETE', `/session/${this.sessionId}`).catch(() => {});
  }

  contexts(): Promise<unknown[]> {
    return this.call('GET', this.s('/contexts'));
  }

  setContext(name: string): Promise<unknown> {
    return this.call('POST', this.s('/context'), { name });
  }

  execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.call('POST', this.s('/execute/sync'), { script, args });
  }

  async find(using: string, value: string): Promise<string> {
    const v = await this.call<Record<string, string>>('POST', this.s('/element'), { using, value });
    return v[ELEMENT];
  }

  click(id: string): Promise<unknown> {
    return this.call('POST', this.s(`/element/${id}/click`), {});
  }

  rect(id: string): Promise<Rect> {
    return this.call('GET', this.s(`/element/${id}/rect`));
  }

  actions(body: unknown): Promise<unknown> {
    return this.call('POST', this.s('/actions'), body);
  }

  screenshot(): Promise<string> {
    return this.call('GET', this.s('/screenshot'));
  }
}
