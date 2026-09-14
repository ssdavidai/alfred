import {
  fields,
  remoteFields,
  type ChatMessage,
  type RemoteTask,
  type TaskFields,
} from "./model.js";

export interface OmiRemote {
  messages(since: string): Promise<ChatMessage[]>;
  tasks(): Promise<RemoteTask[]>;
  create(t: TaskFields): Promise<RemoteTask>;
  update(id: string, t: TaskFields): Promise<void>;
}
export class OmiClient implements OmiRemote {
  private deadline = Date.now() + 180000;
  constructor(
    private key: string,
    private http: typeof fetch = fetch,
  ) {}
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Omi synchronization deadline reached; retry next cycle");
    const r = await this.http("https://api.omi.me/v1/mcp" + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(15000, remaining)),
    });
    if (!r.ok)
      throw new Error(
        `Omi ${method} failed (${r.status}); ${r.status === 429 ? "rate limited; retry later" : "check connection"}`,
      );
    return r.status === 204 ? null : r.json();
  }
  async profile() {
    return this.request("/profile");
  }
  async messages(since: string): Promise<ChatMessage[]> {
    const result: ChatMessage[] = [];
    // Overlap reads plus stable IDs tolerate concurrent inserts during offset pagination.
    for (let offset = 0; offset < 20000; offset += 200) {
      const page = await this.request(`/chat?limit=200&offset=${offset}`);
      if (!Array.isArray(page)) throw new Error("Unexpected Omi chat response");
      result.push(...page);
      if (
        page.length < 200 ||
        page.some(
          (m: ChatMessage) => Date.parse(m.created_at) < Date.parse(since),
        )
      )
        return result;
    }
    throw new Error(
      "Omi history pagination limit reached; cursor not advanced",
    );
  }
  async tasks(): Promise<RemoteTask[]> {
    const result: RemoteTask[] = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const page = await this.request(
        `/action-items?limit=500&offset=${offset}`,
      );
      if (!Array.isArray(page))
        throw new Error("Unexpected Omi tasks response");
      result.push(...page);
      if (page.length < 500) return result;
    }
    throw new Error("Omi task pagination limit reached; no deletions inferred");
  }
  async create(t: TaskFields): Promise<RemoteTask> {
    const result = await this.request("/action-items", "POST", {
      description: t.title,
      due_at: t.due_at,
      completed: t.completed,
    });
    if (!result?.id)
      throw new Error("Omi create returned no task ID; outcome uncertain");
    return result;
  }
  async update(id: string, t: TaskFields): Promise<void> {
    const endpoint = "/action-items/" + encodeURIComponent(id);
    await this.request(endpoint, "PATCH", {
      description: t.title,
      due_at: t.due_at,
    });
    const actual = await this.request(
      endpoint + `/complete?completed=${t.completed}`,
      "POST",
    );
    if (
      !actual?.id ||
      JSON.stringify(remoteFields(actual)) !== JSON.stringify(fields(t))
    )
      throw new Error(
        "Omi did not retain the requested task values; reconciliation required",
      );
  }
}
