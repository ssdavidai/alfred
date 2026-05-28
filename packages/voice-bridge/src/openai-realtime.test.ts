// openai-realtime.test.ts — integration tests for the connect-handshake race fix.
//
// The 2026-05-28 voice-bridge regression had `connect()` resolve on
// `session.created` (default config in effect) rather than on
// `session.updated` (our persona/VAD/tools applied). Twilio media frames and
// the greeting trigger could therefore reach the model before its
// configuration applied — producing dead-on-arrival hallucinations + a
// non-interruptible turn-detector.
//
// These tests stand up a tiny mock OpenAI Realtime WS server and assert:
//   1. connect() does NOT resolve on session.created alone — even after the
//      server-side session.update has been seen — until session.updated lands.
//   2. connect() rejects if session.updated never arrives within the 5s
//      timeout (we use a shorter timeout via env override for test speed).
//   3. appendAudio + triggerGreeting are no-ops while sessionReady is false.
//
// Runs under `node --test`. No mocha/jest dep added — just Node 22's
// builtin test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

// IMPORTANT: env must be set before importing the SUT module, because config.ts
// reads env at module-load time.
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

test("connect() resolves only after session.updated, not session.created", async () => {
  let sessionUpdateSeen: any = null;
  const server = await startMockOpenAI((ws) => {
    // 1. send session.created immediately
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s_test" } }));
    // 2. record the client's session.update, then delay the ACK by 200ms
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        sessionUpdateSeen = ev;
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "session.updated",
              session: ev.session,
            }),
          );
        }, 200);
      }
    });
  });

  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { OpenAIRealtimeClient } = await import("./openai-realtime.js");
    const client = new OpenAIRealtimeClient("test-1");

    const start = Date.now();
    let resolvedAt: number | null = null;
    let readyAtResolve = false;
    const connectP = client
      .connect({ instructions: "test persona" })
      .then(() => {
        resolvedAt = Date.now();
        readyAtResolve = client.isReady;
      });

    // After 50ms (session.created should have arrived, session.updated should NOT),
    // connect must still be pending.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(resolvedAt, null, "connect resolved on session.created — race regressed");
    assert.equal(client.isReady, false, "isReady true before session.updated — regression");

    await connectP;
    assert.ok(resolvedAt !== null, "connect never resolved");
    assert.ok(readyAtResolve, "isReady was false when connect resolved");
    assert.ok(
      (resolvedAt as number) - start >= 180,
      `connect resolved too fast (${(resolvedAt as number) - start}ms) — must wait for session.updated (~200ms)`,
    );
    assert.ok(sessionUpdateSeen, "server never received session.update from client");
    // GA-schema sanity: payload still has the expected nested shape.
    assert.equal(sessionUpdateSeen.session.type, "realtime");
    // 2026-05-28: switched semantic_vad → server_vad after the home-call VAD
    // failure (CAc28fd7...bbc6). semantic_vad's classifier did not detect Sir's
    // mid-reply interrupt on Twilio's 8 kHz μ-law carrier audio; server_vad
    // with tuned narrow-band thresholds is the Twilio-reference recipe.
    assert.equal(
      sessionUpdateSeen.session.audio.input.turn_detection.type,
      "server_vad",
    );
    assert.equal(
      sessionUpdateSeen.session.audio.input.turn_detection.interrupt_response,
      true,
    );
    assert.equal(
      sessionUpdateSeen.session.audio.input.turn_detection.threshold,
      0.5,
    );
    assert.equal(
      sessionUpdateSeen.session.audio.input.turn_detection.silence_duration_ms,
      500,
    );
    assert.equal(
      sessionUpdateSeen.session.audio.input.turn_detection.prefix_padding_ms,
      300,
    );

    client.close();
  } finally {
    await server.close();
  }
});

test("appendAudio is dropped while sessionReady is false", async () => {
  // Server that sends session.created + NEVER session.updated.
  const audioReceived: string[] = [];
  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s_test2" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "input_audio_buffer.append") audioReceived.push(ev.audio);
    });
  });

  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { OpenAIRealtimeClient } = await import("./openai-realtime.js");
    const client = new OpenAIRealtimeClient("test-drop");

    // Don't await connect — it'll never resolve. Start it then probe.
    client.connect({ instructions: "test" }).catch(() => {
      /* expected to reject on timeout */
    });

    // Give the WS time to open + session.created to flow.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.isReady, false);

    // appendAudio should silently drop the chunk.
    client.appendAudio("AAAA");
    client.appendAudio("BBBB");

    // Give the WS a tick to forward anything that might have been sent.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      audioReceived,
      [],
      "appendAudio leaked audio to the model before session.updated",
    );

    // triggerGreeting must also no-op pre-ack.
    client.triggerGreeting();
    await new Promise((r) => setTimeout(r, 50));

    client.close();
  } finally {
    await server.close();
  }
});

test("submitToolResult suppresses response.create while a response is active", async () => {
  // Reproduces the 2026-05-27 home-call collision: in server_vad mode the server
  // auto-creates a response after each `function_call_output`, so a follow-up
  // `response.create` from the client collides as `conversation_already_has_
  // active_response`. The fix: track the active response_id off `response.
  // created`/`response.done` and skip the explicit create while one is in flight.
  const messagesSeen: any[] = [];
  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s_tool" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      messagesSeen.push(ev);
      if (ev.type === "session.update") {
        ws.send(JSON.stringify({ type: "session.updated", session: ev.session }));
        // Simulate the server auto-creating a response right after the session
        // is updated (mirrors what happens after function_call_output in
        // server_vad mode with create_response: true).
        ws.send(
          JSON.stringify({
            type: "response.created",
            response: { id: "resp_active_1" },
          }),
        );
      }
    });
  });

  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { OpenAIRealtimeClient } = await import("./openai-realtime.js");
    const client = new OpenAIRealtimeClient("test-tool-collision");

    await client.connect({ instructions: "t" });
    // Give the mock a tick to push response.created.
    await new Promise((r) => setTimeout(r, 50));

    client.submitToolResult("call_abc", JSON.stringify({ ok: true }));
    await new Promise((r) => setTimeout(r, 50));

    // We expect the conversation.item.create but NOT a response.create
    // because resp_active_1 is still in flight.
    const itemCreate = messagesSeen.find(
      (m) =>
        m.type === "conversation.item.create" &&
        m.item?.type === "function_call_output",
    );
    const responseCreate = messagesSeen.find((m) => m.type === "response.create");
    assert.ok(itemCreate, "function_call_output was not sent");
    assert.equal(
      responseCreate,
      undefined,
      "response.create leaked while a response was active — would collide as conversation_already_has_active_response",
    );

    // After response.done lands, a subsequent submitToolResult must send
    // response.create again (no in-flight response to ride on).
    server.wss.clients.forEach((c) =>
      c.send(
        JSON.stringify({
          type: "response.done",
          response: { id: "resp_active_1" },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));

    const before = messagesSeen.length;
    client.submitToolResult("call_def", JSON.stringify({ ok: true }));
    await new Promise((r) => setTimeout(r, 50));
    const newMsgs = messagesSeen.slice(before);
    assert.ok(
      newMsgs.some((m) => m.type === "response.create"),
      "response.create was not sent after response.done cleared the active-response gate",
    );

    client.close();
  } finally {
    await server.close();
  }
});

test("connect() rejects if session.updated never arrives", async () => {
  // Stub the timeout via env: the SUT reads SESSION_UPDATE_ACK_TIMEOUT_MS as a
  // const, but for this test we set the base URL to a server that sends
  // session.created and then sits silent. The real 5s timeout would make the
  // test slow, so we shorten it via the dedicated test env (read by SUT).
  process.env.VOICE_BRIDGE_ACK_TIMEOUT_MS_FOR_TEST = "500";

  const server = await startMockOpenAI((ws) => {
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s_silent" } }));
    // ... and never reply to session.update
  });

  try {
    process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${server.port}/`;
    const { OpenAIRealtimeClient } = await import("./openai-realtime.js");
    const client = new OpenAIRealtimeClient("test-timeout");

    const start = Date.now();
    let rejectErr: Error | null = null;
    try {
      await client.connect({ instructions: "test" });
    } catch (err) {
      rejectErr = err as Error;
    }
    const elapsed = Date.now() - start;

    assert.ok(rejectErr, "connect did not reject on missing session.updated");
    assert.match(rejectErr!.message, /session\.update ACK timeout|WS closed/);
    // Allow a wide window — even the 5s prod default would pass; we just want
    // to know it eventually errored.
    assert.ok(elapsed < 6_000, `timeout took too long: ${elapsed}ms`);

    client.close();
  } finally {
    await server.close();
    delete process.env.VOICE_BRIDGE_ACK_TIMEOUT_MS_FOR_TEST;
  }
});
