import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omi-pilot-http-"));
Object.assign(process.env, {
  VAULT_PATH: path.join(tmp, "vault"),
  STATE_DB_PATH: path.join(tmp, "state.db"),
  INGEST_DB_PATH: path.join(tmp, "ingest.db"),
  ALFRED_DATA_DIR: tmp,
  COMPOSE_DIR: tmp,
  AAS_API_KEY: "test-owner-key",
  OMI_PILOT_ENABLED: "true",
  SQLITE_VEC_PATH: "",
  OMI_MCP_PUBLIC_URL: "https://mcp.example.test/omi/mcp",
  VAULT_CLI_URL: "http://test-vault:8087",
});
fs.mkdirSync(process.env.VAULT_PATH!, { recursive: true });
fs.writeFileSync(
  path.join(process.env.VAULT_PATH!, "SOUL.md"),
  "You are a concise assistant. Respond in Hungarian.",
);
const { createApiServer } = await import("../src/api/server.js");
const { setApiKey } = await import("../src/api/auth.js");
setApiKey("test-owner-key");
const { getStateDb, closeStateDb } = await import("../src/db/state.js");
const server = createApiServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.AAS_PORT = String((server.address() as any).port);
const base = `http://127.0.0.1:${process.env.AAS_PORT}`;
const fetchOriginal = globalThis.fetch;
let profileEmail = "owner@example.test",
  storedKey = "",
  remoteTasks: any[] = [],
  messages: any[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input),
    method = init?.method || "GET";
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.startsWith("http://test-vault:8087/")) {
    if (url.includes("/list/")) return json({ success: true, data: [] });
    if (method === "POST") {
      storedKey = JSON.parse(String(init?.body)).login.password;
      return json({ success: true, data: { id: "secret-1" } });
    }
    return json({ success: true, data: { login: { password: storedKey } } });
  }
  if (url.startsWith("https://api.omi.me/v1/mcp")) {
    if (url.endsWith("/profile")) return json({ email: profileEmail });
    if (url.includes("/chat?")) return json(messages);
    if (url.includes("/action-items?")) return json(remoteTasks);
    if (url.endsWith("/action-items") && method === "POST") {
      const r = {
        ...JSON.parse(String(init?.body)),
        id: "remote-" + (remoteTasks.length + 1),
      };
      remoteTasks.push(r);
      return json(r);
    }
    if (url.includes("/complete?")) return json({ status: "ok" });
    if (method === "PATCH") return json({ status: "ok" });
    return json({}, 404);
  }
  return fetchOriginal(input, init);
};
after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise<void>((r) => server.close(() => r()));
  closeStateDb();
});
async function call(
  endpoint: string,
  method = "GET",
  body?: unknown,
  key = "test-owner-key",
) {
  const r = await fetchOriginal(
    base + "/api/v1/channels/omi/pilot" + endpoint,
    {
      method,
      headers: {
        Authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: r.status, data: (await r.json()) as any };
}
test("authenticated HTTP slice: identity, account binding, canonical task, history and revocation", async () => {
  assert.equal((await call("/status", "GET", undefined, "wrong")).status, 401);
  const mismatch = await call("/connection", "PUT", {
    expected_email: "someone-else@example.test",
    api_key: "omi_mcp_test",
  });
  assert.equal(mismatch.status, 400);
  const connected = await call("/connection", "PUT", {
    expected_email: profileEmail,
    api_key: "omi_mcp_test",
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  assert.equal(connected.data.writes_enabled, false);
  assert.ok(!JSON.stringify(connected.data).includes("omi_mcp_test"));
  messages = [
    {
      id: "human-1",
      sender: "human",
      text: "Create a supplier task",
      created_at: new Date().toISOString(),
    },
    {
      id: "ai-1",
      sender: "ai",
      text: "I will prepare it.",
      created_at: new Date().toISOString(),
    },
  ];
  assert.equal((await call("/sync", "POST", {})).status, 200);
  const context = await call("/context", "POST", { message: "supplier" });
  assert.equal(context.status, 200, JSON.stringify(context.data));
  assert.match(context.data.identity["SOUL.md"], /Hungarian/);
  assert.equal(context.data.recent_exchanges.length, 2);
  await call("/writes", "PUT", { enabled: true });
  const request = {
    request_id: "http_request_001",
    operation: "create_task",
    task: { title: "Supplier follow-up", due_at: null, completed: false },
  };
  const created = await call("/command", "POST", request);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.deepEqual(
    (await call("/command", "POST", request)).data,
    created.data,
  );
  await call("/sync", "POST", {});
  assert.equal(remoteTasks.length, 1);
  remoteTasks[0].completed = true;
  await call("/sync", "POST", {});
  const tasks = await call("/read", "POST", { kind: "tasks" });
  assert.equal(tasks.data.tasks[0].completed, true);
  assert.equal(
    (await call("/read", "POST", { kind: "record", path: "SOUL.md" })).status,
    400,
  );
  assert.equal(
    (await call("/read", "POST", { kind: "record", path: "task/../SOUL.md" }))
      .status,
    400,
  );
  assert.equal(
    (await call("/command", "POST", { ...request, operation: "execute_shell" }))
      .status,
    400,
  );
  profileEmail = "other@example.test";
  assert.equal(
    (
      await call("/connection", "PUT", {
        expected_email: profileEmail,
        api_key: "new-key",
      })
    ).status,
    400,
  );
  await call("/connection", "DELETE");
  assert.notEqual(
    (await call("/context", "POST", { message: "hello" })).status,
    200,
  );
  assert.equal(
    getStateDb().prepare("SELECT count(*) AS n FROM omi_message_receipt").get()
      ?.n,
    2,
  );
});
