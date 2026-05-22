// F15 / C14 — email provision + status response shapes.
// Invokes the registered handlers directly via matchRoute with a fake res,
// asserting the frozen C14 shapes: POST /provision → 200 {configured,
// inbox_address, inbox_id, webhook_registered} / 4xx {error, code}; GET
// /status → {configured, inbox_address|null}.
import { mock, describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

let inboxStatus = 200;
let inboxBody: any = { inboxes: [{ inbox_id: "inbox_abc", email: "a@mail.alfred.black" }] };
let createdHooks: string[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url), m = (init?.method ?? "GET").toUpperCase();
  if (/\/v0\/inboxes$/.test(u)) return new Response(JSON.stringify(inboxBody), { status: inboxStatus });
  if (/\/v0\/webhooks$/.test(u) && m === "GET") return new Response('{"webhooks":[]}', { status: 200 });
  if (/\/v0\/webhooks$/.test(u)) { createdHooks.push(JSON.parse(init.body).url); return new Response("{}", { status: 200 }); }
  return new Response("{}", { status: 501 });
}) as typeof globalThis.fetch;

const memFs = new Map<string, string>();
const fsMock: any = {
  existsSync: (p: string) => memFs.has(p),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => memFs.set(p, String(d)), mkdirSync() {},
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });
process.env.SAAS_HOST = "https://alfred.black";
delete process.env.AGENTMAIL_API_KEY; delete process.env.AGENTMAIL_INBOX_ID;

const { matchRoute } = await import("../src/api/server.js");
(await import("../src/api/routes/email.js")).registerEmailRoutes();

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const matched = matchRoute(method, path);
  assert.ok(matched, `no route ${method} ${path}`);
  let status = 0, data: any;
  const res: any = { writeHead(s: number) { status = s; }, end(j: string) { data = JSON.parse(j); } };
  await matched.handler({ res, params: matched.params, body, query: new URLSearchParams(), req: {} as any });
  return { status, data };
}

describe("F15 / C14 — email provision + status", () => {
  before(() => { /* routes registered at import */ });
  beforeEach(() => { memFs.clear(); inboxStatus = 200; inboxBody = { inboxes: [{ inbox_id: "inbox_abc", email: "a@mail.alfred.black" }] }; createdHooks = []; });

  it("status unconfigured → {configured:false, inbox_address:null}", async () => {
    const { status, data } = await call("GET", "/api/v1/email/status");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual({ configured: data.configured, inbox_address: data.inbox_address }, { configured: false, inbox_address: null });
  });

  it("provision → C14 shape + webhook; status then reflects it; re-provision idempotent", async () => {
    const { status, data } = await call("POST", "/api/v1/email/provision", { api_key: "k" });
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data, { configured: true, inbox_address: "a@mail.alfred.black", inbox_id: "inbox_abc", webhook_registered: true });
    assert.deepStrictEqual(createdHooks, ["https://alfred.black/webhooks/agentmail"]);
    const st = await call("GET", "/api/v1/email/status");
    assert.deepStrictEqual({ c: st.data.configured, a: st.data.inbox_address }, { c: true, a: "a@mail.alfred.black" });
    createdHooks = []; const re = await call("POST", "/api/v1/email/provision", { api_key: "k" });
    assert.strictEqual(re.data.webhook_registered, true);
  });

  it("missing / bad / inbox-less keys → 4xx {error, code}", async () => {
    const miss = await call("POST", "/api/v1/email/provision", {});
    assert.strictEqual(miss.status, 400); assert.ok(miss.data.error); assert.strictEqual(miss.data.code, "missing_api_key");
    inboxStatus = 401;
    assert.strictEqual((await call("POST", "/api/v1/email/provision", { api_key: "x" })).data.code, "invalid_api_key");
    inboxStatus = 200; inboxBody = { inboxes: [] };
    assert.strictEqual((await call("POST", "/api/v1/email/provision", { api_key: "x" })).data.code, "no_inbox");
  });
});
