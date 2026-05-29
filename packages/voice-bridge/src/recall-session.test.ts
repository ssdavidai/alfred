// recall-session.test.ts — #113 PR5.
//
// Drives the runRecallTurn() loop against a mock OpenAI Realtime WS server
// to validate the full wake-word → response audio round-trip. Covers:
//
//   1. Happy path: transcript in → audio + text out
//   2. Latency budget — p95 ≤ 1500ms over 10 sequential turns
//   3. mid-utterance error → returns ok=false with partial audio
//   4. session.update never acked → timeout surfaces ok=false
//   5. response.done with empty audio → ok=true, audio_base64=""
//   6. buildMeetingPrefix renders meeting context cleanly
//   7. buildMeetingPrefix degrades gracefully on missing context
//   8. normaliseCalendarEvent extracts title/attendees from a gcal shape
//   9. multi-chunk audio reassembles back to the original bytes
//   10. unknown event types are ignored without breaking the loop

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";

interface MockServer {
  wss: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}

async function startMockOpenAI(handler: (ws: any) => void): Promise<MockServer> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  wss.on("connection", (ws) => {
    handler(ws);
  });
  return {
    wss,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function happyPathServer(opts: {
  audioChunks?: string[];
  transcript?: string;
  delayMs?: number;
} = {}): (ws: any) => void {
  const chunks = opts.audioChunks ?? [
    Buffer.from("hello").toString("base64"),
    Buffer.from(" world").toString("base64"),
  ];
  const transcript = opts.transcript ?? "Yes sir, on it.";
  const delay = opts.delayMs ?? 5;
  return (ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s1" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: "session.updated",
                session: ev.session,
              }),
            ),
          delay,
        );
      }
      if (ev.type === "response.create") {
        setTimeout(() => {
          for (const c of chunks) {
            ws.send(
              JSON.stringify({
                type: "response.output_audio.delta",
                delta: c,
              }),
            );
          }
          for (const tok of transcript.split(/(?=\s)/)) {
            ws.send(
              JSON.stringify({
                type: "response.output_audio_transcript.delta",
                delta: tok,
              }),
            );
          }
          ws.send(JSON.stringify({ type: "response.done" }));
        }, delay);
      }
    });
  };
}

test("happy path: transcript in → audio + text out", async () => {
  const server = await startMockOpenAI(happyPathServer());
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const result = await runRecallTurn({
      botId: "bot-1",
      transcript: "Hey Alfred, what's next?",
      wakeWord: "Hey Alfred",
      meetingContext: null,
    });
    assert.equal(result.ok, true);
    assert.ok(result.audio_base64.length > 0);
    assert.match(result.text, /Yes sir/);
    assert.ok(result.latency_ms < 2_000, `p95 budget: ${result.latency_ms}ms`);
  } finally {
    await server.close();
  }
});

test("p95 latency budget under 1500 ms over 10 sequential turns", async () => {
  const server = await startMockOpenAI(happyPathServer({ delayMs: 1 }));
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await runRecallTurn({
        botId: `bot-${i}`,
        transcript: "Hey Alfred",
        wakeWord: "Hey Alfred",
        meetingContext: null,
      });
      assert.equal(r.ok, true);
      samples.push(r.latency_ms);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
    assert.ok(p95 < 1500, `p95 latency ${p95}ms exceeds 1500ms budget`);
  } finally {
    await server.close();
  }
});

test("mid-stream error returns ok=false with partial audio", async () => {
  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s2" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        ws.send(JSON.stringify({ type: "session.updated", session: ev.session }));
      }
      if (ev.type === "response.create") {
        ws.send(
          JSON.stringify({
            type: "response.output_audio.delta",
            delta: Buffer.from("partial").toString("base64"),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: { message: "synthetic openai failure" },
          }),
        );
      }
    });
  });
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const result = await runRecallTurn({
      botId: "bot-err",
      transcript: "Hey Alfred",
      wakeWord: "Alfred",
      meetingContext: null,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /synthetic openai failure/);
    assert.ok(result.audio_base64.length > 0, "partial audio should survive");
  } finally {
    await server.close();
  }
});

test("session.update never acked → timeout surfaces ok=false", async () => {
  const server = await startMockOpenAI((ws) => {
    // session.created sent — session.updated never sent.
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s3" } }));
  });
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const result = await runRecallTurn({
      botId: "bot-tmo",
      transcript: "Hey Alfred",
      wakeWord: "Alfred",
      meetingContext: null,
      timeoutMs: 150,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /timed out/);
  } finally {
    await server.close();
  }
});

test("response.done with zero audio → ok=true, empty audio", async () => {
  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s4" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        ws.send(
          JSON.stringify({ type: "session.updated", session: ev.session }),
        );
      }
      if (ev.type === "response.create") {
        ws.send(JSON.stringify({ type: "response.done" }));
      }
    });
  });
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const result = await runRecallTurn({
      botId: "bot-empty",
      transcript: "Hey Alfred",
      wakeWord: "Alfred",
      meetingContext: null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.audio_base64, "");
    assert.equal(result.text, "");
  } finally {
    await server.close();
  }
});

test("buildMeetingPrefix includes meeting title and attendees", async () => {
  const { buildMeetingPrefix } = await import("./recall-meeting-context.js");
  const out = buildMeetingPrefix(
    {
      title: "Q3 Pricing Review",
      start: "2026-05-29T10:00:00Z",
      end: "2026-05-29T11:00:00Z",
      organiser: "ceo@alfred.black",
      attendees: ["Alice", "Bob"],
      agenda: "Walk through the new pricing tiers and the LTM forecast.",
      notes: ["Sir prefers tier B for the SMB segment."],
    },
    "Hey Alfred",
  );
  assert.match(out, /Q3 Pricing Review/);
  assert.match(out, /Alice, Bob/);
  assert.match(out, /Hey Alfred/);
  assert.match(out, /Sir prefers tier B/);
  assert.match(out, /1-2 sentences/i);
});

test("buildMeetingPrefix degrades cleanly on null context", async () => {
  const { buildMeetingPrefix } = await import("./recall-meeting-context.js");
  const out = buildMeetingPrefix(null, "Alfred");
  // Even with null context, we still produce a usable persona prefix
  // that names the wake-word and disciplines the speech rules.
  assert.match(out, /You are Alfred/);
  assert.match(out, /Alfred/);
  assert.match(out, /1-2 sentences/i);
});

// ─── Persona-impersonation guard (Sir explicit, 2026-05-29 evening) ─────
//
// The bot in the meeting MUST speak AS ALFRED, never as the principal.
// These assertions are the regression net for the three-layer
// enforcement described in recall-meeting-context.ts:
//   1. opening identity ("You are Alfred … attending on the principal's behalf")
//   2. announce-on-join phrase ("Alfred here on behalf of Sir, listening")
//   3. closing CRITICAL guardrail ("'I' means YOU, Alfred — never the principal")
//
// If any of these regress, an attendee asking "are you David?" can elicit
// "yes, this is David" — which would be a load-bearing breach of trust.

test("buildMeetingPrefix enforces the three-layer impersonation guard", async () => {
  const { buildMeetingPrefix } = await import("./recall-meeting-context.js");
  const out = buildMeetingPrefix(null, "Alfred");
  // Layer 1: opening identity line establishes Alfred as a separate persona.
  assert.match(
    out,
    /You are Alfred.*attending this meeting on the principal's behalf/,
    "opening identity line must establish Alfred as separate from the principal",
  );
  assert.match(
    out,
    /NOT the principal/,
    "must explicitly say NOT the principal",
  );
  assert.match(
    out,
    /NEVER impersonate the principal/,
    "must explicitly forbid impersonation",
  );
  // Layer 2: announce-on-join phrase.
  assert.match(
    out,
    /Alfred here on behalf of Sir/,
    "must include the announce-on-join phrase",
  );
  // Layer 3: closing CRITICAL guardrail.
  assert.match(
    out,
    /CRITICAL.*"I" always refers to YOU, Alfred — never to the principal/,
    "must include the closing CRITICAL guardrail",
  );
  assert.match(
    out,
    /NEVER say "I am Sir"/,
    "must explicitly forbid 'I am Sir'",
  );
});

test("buildRecallInstructions includes voice + persona-as-Alfred constraint", async () => {
  const { buildRecallInstructions } = await import("./recall-session.js");
  const out = buildRecallInstructions({
    botId: "bot-1",
    transcript: "Hey Alfred, what's the agenda?",
    wakeWord: "Hey Alfred",
    meetingContext: null,
  });
  // The persona body must reinforce Alfred's voice ownership.
  assert.match(
    out,
    /in your own voice as Alfred the butler/,
    "persona must reinforce Alfred's voice ownership",
  );
  assert.match(
    out,
    /you are Alfred/i,
    "persona body must reiterate Alfred identity",
  );
  assert.match(
    out,
    /never the principal/i,
    "persona body must reiterate the impersonation prohibition",
  );
  // And the three-layer prefix is still present underneath.
  assert.match(out, /Alfred here on behalf of Sir/);
});

test("normaliseCalendarEvent picks title + attendees out of a gcal shape", async () => {
  const { normaliseCalendarEvent } = await import("./recall-meeting-context.js");
  const out = normaliseCalendarEvent({
    summary: "Standup",
    start: { dateTime: "2026-05-29T10:00:00Z" },
    end: { dateTime: "2026-05-29T10:30:00Z" },
    organizer: { email: "ceo@alfred.black" },
    attendees: [
      { email: "alice@example.com", displayName: "Alice Wonderland" },
      { email: "bob@example.com" },
    ],
    description: "Quick sync on the launch checklist.",
  });
  assert.equal(out.title, "Standup");
  assert.equal(out.start, "2026-05-29T10:00:00Z");
  assert.equal(out.organiser, "ceo@alfred.black");
  assert.deepEqual(out.attendees, ["Alice Wonderland", "bob@example.com"]);
  assert.match(out.agenda ?? "", /launch checklist/);
});

test("multi-chunk audio reassembles back to the source bytes", async () => {
  // Mock server emits two base64 chunks that each decode to a multi-byte
  // PCM-aligned blob. Recall-session must concat them via decode/re-encode
  // so the result round-trips to the original buffer.
  const original = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const chunkA = original.subarray(0, 5).toString("base64"); // 5 bytes → not %3
  const chunkB = original.subarray(5).toString("base64"); // 7 bytes → not %3
  const server = await startMockOpenAI(
    happyPathServer({ audioChunks: [chunkA, chunkB], transcript: "ok" }),
  );
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const result = await runRecallTurn({
      botId: "bot-multi",
      transcript: "Hey Alfred",
      wakeWord: "Alfred",
      meetingContext: null,
    });
    assert.equal(result.ok, true);
    const reassembled = Buffer.from(result.audio_base64, "base64");
    assert.deepEqual(Array.from(reassembled), Array.from(original));
  } finally {
    await server.close();
  }
});

test("unknown event types are ignored without breaking the loop", async () => {
  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s5" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        ws.send(
          JSON.stringify({ type: "session.updated", session: ev.session }),
        );
      }
      if (ev.type === "response.create") {
        ws.send(JSON.stringify({ type: "rate_limits.updated", limits: [] }));
        ws.send(JSON.stringify({ type: "conversation.item.created" }));
        ws.send(
          JSON.stringify({
            type: "response.output_audio.delta",
            delta: Buffer.from("ok").toString("base64"),
          }),
        );
        ws.send(JSON.stringify({ type: "response.done" }));
      }
    });
  });
  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { runRecallTurn } = await import("./recall-session.js");
    const r = await runRecallTurn({
      botId: "bot-unknown",
      transcript: "Hey Alfred",
      wakeWord: "Alfred",
      meetingContext: null,
    });
    assert.equal(r.ok, true);
    assert.equal(Buffer.from(r.audio_base64, "base64").toString(), "ok");
  } finally {
    await server.close();
  }
});
