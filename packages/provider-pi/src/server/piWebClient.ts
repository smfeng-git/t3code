export type PiWebRecord = Record<string, unknown>;

function record(value: unknown): PiWebRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pi Web returned an invalid response");
  }
  return value as PiWebRecord;
}

export class PiWebClient {
  readonly baseUrl: URL;
  private readonly headers: Record<string, string>;
  private readonly fetch: typeof globalThis.fetch;

  constructor(baseUrl: string, fetch: typeof globalThis.fetch, password?: string) {
    this.fetch = fetch;
    this.baseUrl = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(this.baseUrl.protocol) ||
      this.baseUrl.username ||
      this.baseUrl.password
    ) {
      throw new Error("Pi Web URL must be HTTP(S) without embedded credentials");
    }
    this.headers = {
      "Content-Type": "application/json",
      ...(password
        ? { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` }
        : {}),
    };
  }

  private async request(path: string, body?: PiWebRecord, signal?: AbortSignal) {
    const response = await this.fetch(new URL(path, this.baseUrl), {
      headers: this.headers,
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30_000),
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Pi Web request failed (${response.status})`);
    const data = record(await response.json());
    if (data.success === false || typeof data.error === "string") {
      throw new Error("Pi Web rejected the request");
    }
    return data;
  }

  listSessions(signal?: AbortSignal) {
    return this.request("/api/sessions", undefined, signal);
  }

  running(signal?: AbortSignal) {
    return this.request("/api/agent/running", undefined, signal);
  }

  entries(sessionId: string, after?: string, signal?: AbortSignal) {
    const query = new URLSearchParams(after ? { after } : {});
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/entries?${query}`,
      undefined,
      signal,
    );
  }

  snapshot(sessionId: string, signal?: AbortSignal) {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}?tail=1000`,
      undefined,
      signal,
    );
  }

  context(sessionId: string, before?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ tail: "1000" });
    if (before) query.set("before", before);
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/context?${query}`,
      undefined,
      signal,
    );
  }

  createSession(cwd: string, signal?: AbortSignal) {
    return this.request("/api/agent/new", { cwd, type: "ensure_session" }, signal);
  }

  async command(sessionId: string, command: PiWebRecord, signal?: AbortSignal) {
    const result = await this.request(
      `/api/agent/${encodeURIComponent(sessionId)}`,
      command,
      signal,
    );
    return result.data;
  }

  async *events(sessionId: string, signal: AbortSignal): AsyncGenerator<PiWebRecord> {
    const response = await this.fetch(
      new URL(`/api/agent/${encodeURIComponent(sessionId)}/events`, this.baseUrl),
      {
        headers: this.headers,
        redirect: "error",
        signal,
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Pi Web stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let data: string[] = [];
    let dataLength = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Pi Web stream disconnected; refresh the snapshot before resuming");
        buffered += decoder.decode(chunk.value, { stream: true });
        if (buffered.length + dataLength > 32 * 1024 * 1024)
          throw new Error("Pi Web event exceeds the frame limit");
        let end: number;
        while ((end = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, end).replace(/\r$/, "");
          buffered = buffered.slice(end + 1);
          if (line === "") {
            if (data.length) yield record(JSON.parse(data.join("\n")));
            data = [];
            dataLength = 0;
          } else if (line.startsWith("data:")) {
            const value = line.slice(5).replace(/^ /, "");
            data.push(value);
            dataLength += value.length + 1;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
