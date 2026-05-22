// F16 / C15 — phone provision + credential allowlist + config shape.
// POST /api/v1/phone/provision {openai_api_key, twilio_account_sid,
// twilio_auth_token, phone_number?|buy} → 200 {phone_number, provisioned} /
// 4xx {error, code}. The Twilio/voice keys are allow-listed in
// KNOWN_CREDENTIALS so PATCH /admin/credentials accepts them. GET
// /api/v1/phone/config returns the exact keys {phoneNumber, authorizedNumbers,
// recentActivity} the web wizard reads.
import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const env = new Map<string, string>();
const fsMock: any = {
  existsSync: () => true,
  readFileSync: () => [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  writeFileSync: (_p: string, d: string) => {
    env.clear();
    for (const line of String(d).split("\n")) {
      const i = line.indexOf("="); if (i > 0) env.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  },
  mkdirSync() {}, readdirSync: () => [], appendFileSync() {}, unlinkSync() {}, renameSync() {}, rmSync() {},
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

let restarted: string[][] = [];
const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerComposeCmd: async (args: string[]) => { restarted.push(args); return ""; },
  },
});

const { matchRoute } = await import("../src/api/server.js");
(await import("../src/api/routes/phone.js")).registerPhoneRoutes();
(await import("../src/api/routes/credentials.js")).registerCredentialRoutes();

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const matched = matchRoute(method, path);
  assert.ok(matched, `no route ${method} ${path}`);
  let status = 0, data: any;
  const res: any = { writeHead(s: number) { status = s; }, end(j: string) { data = j ? JSON.parse(j) : undefined; } };
  await matched.handler({ res, params: matched.params, body, query: new URLSearchParams(), req: {} as any });
  return { status, data };
}

describe("F16 / C15 — phone provision", () => {
  beforeEach(() => { env.clear(); restarted = []; });

  it("KNOWN_CREDENTIALS allow-lists the Twilio/voice keys (PATCH accepts them)", async () => {
    const { status } = await call("PATCH", "/api/v1/admin/credentials", {
      TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_PHONE_NUMBER: "+15551112222",
      VOICE_BRIDGE_INTERNAL_TOKEN: "vbt", OPENAI_API_KEY: "sk-x",
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(env.get("TWILIO_ACCOUNT_SID"), "AC123");
    assert.strictEqual(env.get("VOICE_BRIDGE_INTERNAL_TOKEN"), "vbt");
  });

  it("BYO provision persists creds, returns C15 shape, restarts voice-bridge", async () => {
    const { status, data } = await call("POST", "/api/v1/phone/provision", {
      openai_api_key: "sk-x", twilio_account_sid: "AC1", twilio_auth_token: "tok", phone_number: "+15551112222",
    });
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data, { phone_number: "+15551112222", provisioned: true });
    assert.strictEqual(env.get("TWILIO_PHONE_NUMBER"), "+15551112222");
    assert.strictEqual(env.get("OPENAI_API_KEY"), "sk-x");
    assert.deepStrictEqual(restarted, [["up", "-d", "--no-deps", "--force-recreate", "voice-bridge"]]);
  });

  it("buy: path is stubbed → 400 {code:'buy_not_supported'}", async () => {
    const { status, data } = await call("POST", "/api/v1/phone/provision", {
      openai_api_key: "sk-x", twilio_account_sid: "AC1", twilio_auth_token: "tok", buy: { country: "US" },
    });
    assert.strictEqual(status, 400);
    assert.ok(data.error);
    assert.strictEqual(data.code, "buy_not_supported");
    assert.deepStrictEqual(restarted, [], "must not restart on a stubbed buy");
  });

  it("missing required fields → 400 {code:'missing_fields'}", async () => {
    const { status, data } = await call("POST", "/api/v1/phone/provision", { phone_number: "+1555" });
    assert.strictEqual(status, 400);
    assert.strictEqual(data.code, "missing_fields");
  });

  it("config returns the exact C15 keys", async () => {
    const { status, data } = await call("GET", "/api/v1/phone/config");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(Object.keys(data).sort(), ["authorizedNumbers", "phoneNumber", "recentActivity"]);
  });
});
