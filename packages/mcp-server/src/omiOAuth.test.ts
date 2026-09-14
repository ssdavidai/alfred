import { test } from "node:test";
import assert from "node:assert/strict";
import { omiResourceFallback } from "./omiOAuth.js";
import { getToolsForApp } from "./tools/registry.js";
test("Omi primitive task fields translate into the canonical command", () => {
  const tool = getToolsForApp("omi").find((t) => t.name === "omi_task_create")!;
  const args = tool.inputSchema.parse({
    request_id: "request-123",
    title: "Review proposal",
    due_date: "",
    completed: false,
  });
  assert.deepEqual(tool.buildRequest(args).body, {
    request_id: "request-123",
    operation: "create_task",
    task: { title: "Review proposal", due_at: null, completed: false },
  });
});
test("only the exact Omi HTTPS callback gets an Omi-only resource", () => {
  assert.equal(
    omiResourceFallback(
      undefined,
      "https://api.omi.me/v1/apps/mcp/callback",
      "https://mcp.example.test",
    )?.href,
    "https://mcp.example.test/omi/mcp",
  );
  for (const redirect of [
    "https://api.omi.me.evil.test/v1/apps/mcp/callback",
    "http://api.omi.me/v1/apps/mcp/callback",
    "https://api.omi.me/v1/apps/mcp/callback?x=1",
  ])
    assert.equal(
      omiResourceFallback(undefined, redirect, "https://mcp.example.test"),
      undefined,
    );
});
test("Omi tools never expose raw execute, administrative or credentials tools", () => {
  assert.deepEqual(
    getToolsForApp("omi").map((t) => t.name),
    [
      "omi_context",
      "omi_read",
      "omi_task_create",
      "omi_task_update",
      "omi_request_work",
    ],
  );
});
