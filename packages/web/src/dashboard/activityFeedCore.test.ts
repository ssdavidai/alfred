/** Run: cd packages/web && npx tsx --test src/dashboard/activityFeedCore.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatActivityFreshness,
  parseActivityEnvelope,
  selectActivityFeedState,
} from "./activityFeedCore";

test("parses the freshness envelope and workflow correlation metadata", () => {
  const envelope = parseActivityEnvelope({
    generated_at: "2026-07-17T09:05:00.000Z",
    partial: false,
    sources: [{ name: "audit", ok: true, count: 1 }],
    items: [{
      ts: "2026-07-17T09:00:00.000Z",
      action_type: "workflow_run",
      summary: "Workflow run completed",
      payload_json: JSON.stringify({ correlation_id: "corr-xyz" }),
    }],
  });
  assert.equal(
    formatActivityFreshness(envelope.generatedAt),
    "as of 2026-07-17T09:05:00.000Z",
  );
  assert.equal(selectActivityFeedState(envelope), "ready");
  assert.deepEqual(envelope.items[0], {
    timestamp: "2026-07-17T09:00:00.000Z",
    tool: "system",
    level: "info",
    event: "workflow_run",
    message: "Workflow run completed",
    actionType: "workflow_run",
    correlationRef: "corr-xyz",
  });
});

test("keeps complete-empty and partial-empty states distinct", () => {
  const empty = parseActivityEnvelope({
    items: [], partial: false, sources: [{ name: "audit", ok: true, count: 0 }],
  });
  const degraded = parseActivityEnvelope({
    items: [], partial: true,
    sources: [{ name: "audit", ok: false }, { name: "workflows", ok: false }],
  });
  assert.equal(selectActivityFeedState(empty), "empty");
  assert.equal(selectActivityFeedState(degraded), "degraded");
  assert.deepEqual(degraded.failedSources, ["audit", "workflows"]);
});

test("malformed optional payloads do not break envelope parsing", () => {
  const envelope = parseActivityEnvelope({
    items: [
      {
        action_type: "workflow_run",
        subject_ref: "workflow:wf-317",
        payload_json: "{",
      },
    ],
    partial: true,
  });
  assert.equal(envelope.items[0].correlationRef, "workflow:wf-317");
  assert.deepEqual(envelope.failedSources, ["unknown source"]);
  assert.equal(formatActivityFreshness(envelope.generatedAt), "freshness unavailable");
});
