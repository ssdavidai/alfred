// ChatWidget — the dashboard chat surface, Hermes HTTP/SSE edition.
//
// OpenClaw exposed a raw WebSocket at `:18789/`; the old dashboard linked
// straight out to it. Hermes is HTTP/SSE — this widget talks to the Wasp
// server's chat proxy (`src/server/chatProxy.ts`), which forwards to the
// Hermes runtime's `/v1` API directly:
//
//   - streaming turn:  POST /api/chat/run  → SSE GET /api/chat/stream
//   - fallback turn:   POST /api/chat/turn (Hermes POST /v1/responses)
//
// Conversation continuity is carried by `previous_response_id` — every
// turn passes the last response id so Hermes threads the conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "wasp/client";

// Wasp stores the session token in localStorage under "wasp:sessionId".
function getWaspSessionId(): string | null {
  try {
    const raw = localStorage.getItem("wasp:sessionId");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// The chat proxy lives on the Wasp *server* (api.<domain>), not the SPA
// host. `config.apiUrl` is Wasp's canonical server base URL.
function apiBase(): string {
  return (config.apiUrl ?? "").replace(/\/$/, "");
}

type Role = "user" | "assistant";
interface Message {
  id: string;
  role: Role;
  text: string;
  pending?: boolean;
  /** #429 — activity label shown while a pending turn has produced no text
   *  yet (e.g. "Alfred is working", "using sure"). Codex turns don't stream
   *  token deltas, so without this the bubble looks frozen for the whole turn. */
  note?: string;
}

/** #429 — animated "working…" indicator for a pending turn with no text yet. */
function WorkingDots({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 italic opacity-80"
      style={{ color: "var(--brass)" }}
      aria-live="polite"
    >
      {label}
      <span className="inline-flex">
        <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
      </span>
    </span>
  );
}

type Status = "idle" | "checking" | "ready" | "unavailable";

let msgSeq = 0;
function nextId(): string {
  msgSeq += 1;
  return `m${msgSeq}-${Date.now()}`;
}

/**
 * Pull the assistant text out of a Hermes object. Handles both the
 * `/v1/responses` shape (`output_text` / `output[]`) and the `/v1/runs`
 * run object (`output` string or structured list).
 */
function extractText(obj: any): string {
  if (!obj || typeof obj !== "object") return "";
  if (typeof obj.output_text === "string") return obj.output_text;
  const output = obj.output ?? obj.response?.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        if (typeof item.text === "string") parts.push(item.text);
        else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    }
    return parts.join("");
  }
  if (typeof obj.text === "string") return obj.text;
  return "";
}

/** Read the Hermes response/run id from a turn or run payload. */
function extractResponseId(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.response_id ??
    obj.id ??
    obj.run_id ??
    obj.response?.id ??
    null
  );
}

export default function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<Status>("checking");
  const [statusMessage, setStatusMessage] = useState<string>("");

  // Hermes conversation continuity — the id of the last response/run.
  const previousResponseId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // ── Readiness probe ────────────────────────────────────────────
  useEffect(() => {
    const sessionId = getWaspSessionId();
    if (!sessionId) {
      setStatus("unavailable");
      setStatusMessage("Not signed in.");
      return;
    }
    let cancelled = false;
    fetch(`${apiBase()}/api/chat/status`, {
      headers: { Authorization: `Bearer ${sessionId}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok) {
          setStatus("ready");
        } else {
          setStatus("unavailable");
          setStatusMessage(
            data?.message ||
              (data?.error === "not_configured"
                ? "The Hermes runtime is not configured."
                : "Alfred is not reachable right now."),
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("unavailable");
        setStatusMessage("Could not reach the chat service.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Close any open SSE stream on unmount.
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  /** Append tokens to the trailing pending assistant message. */
  const appendToPending = useCallback((assistantId: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, text: m.text + delta } : m,
      ),
    );
  }, []);

  /** Mark the trailing assistant message as finished (or replace its text). */
  const finishPending = useCallback(
    (assistantId: string, finalText?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                pending: false,
                text:
                  finalText && finalText.length > 0 ? finalText : m.text,
              }
            : m,
        ),
      );
    },
    [],
  );

  /**
   * Single-shot fallback — POST /api/chat/turn (Hermes /v1/responses).
   * Used when a streaming run could not be started.
   */
  const sendTurnFallback = useCallback(
    async (sessionId: string, text: string, assistantId: string) => {
      const res = await fetch(`${apiBase()}/api/chat/turn`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: text,
          previousResponseId: previousResponseId.current ?? undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        finishPending(
          assistantId,
          data?.error ? `⚠ ${data.error}` : "⚠ Alfred could not respond.",
        );
        return;
      }
      const rid = extractResponseId(data);
      if (rid) previousResponseId.current = rid;
      finishPending(
        assistantId,
        extractText(data) || "(no response)",
      );
    },
    [finishPending],
  );

  /**
   * Stream a turn — POST /api/chat/run to start a Hermes run, then open an
   * SSE EventSource on /api/chat/stream and render token deltas live.
   */
  const sendStreaming = useCallback(
    async (sessionId: string, text: string, assistantId: string) => {
      // 1. Create the run.
      let runId: string | null = null;
      try {
        const res = await fetch(`${apiBase()}/api/chat/run`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionId}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: text,
            previousResponseId: previousResponseId.current ?? undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data) {
          runId = data.id ?? data.run_id ?? null;
          // A run that returns its output synchronously (no streaming
          // window) — render it and stop here.
          const immediate = extractText(data);
          const status = String(data.status ?? "");
          if (
            (status === "completed" || status === "succeeded") &&
            immediate
          ) {
            const rid = extractResponseId(data);
            if (rid) previousResponseId.current = rid;
            finishPending(assistantId, immediate);
            return;
          }
        }
      } catch {
        runId = null;
      }

      if (!runId) {
        // Streaming path unavailable — fall back to a single-shot turn.
        await sendTurnFallback(sessionId, text, assistantId);
        return;
      }

      // 2. Open the SSE stream. EventSource can't carry an Authorization
      //    header, so the Wasp session token rides as `?token=`.
      await new Promise<void>((resolve) => {
        const url =
          `${apiBase()}/api/chat/stream?runId=${encodeURIComponent(runId!)}` +
          `&token=${encodeURIComponent(sessionId)}`;
        const es = new EventSource(url);
        esRef.current = es;
        let gotAny = false;
        let settled = false;

        const done = () => {
          if (settled) return;
          settled = true;
          es.close();
          esRef.current = null;
          resolve();
        };

        const handleEvent = (raw: string) => {
          if (!raw) return;
          let payload: any = raw;
          try {
            payload = JSON.parse(raw);
          } catch {
            /* plain-text delta */
          }
          // Hermes SSE deltas vary in shape — accept the common ones.
          const delta =
            typeof payload === "string"
              ? payload
              : payload?.delta ??
                payload?.text ??
                payload?.output_text_delta ??
                extractText(payload);
          if (delta) {
            gotAny = true;
            appendToPending(assistantId, String(delta));
          }
          const rid = extractResponseId(
            typeof payload === "object" ? payload : null,
          );
          if (rid) previousResponseId.current = rid;
        };

        // Token / output deltas.
        es.addEventListener("message", (ev) => handleEvent((ev as MessageEvent).data));
        es.addEventListener("delta", (ev) => handleEvent((ev as MessageEvent).data));
        es.addEventListener("response.output_text.delta", (ev) =>
          handleEvent((ev as MessageEvent).data),
        );

        // Terminal events.
        const terminal = (ev: Event) => {
          const data = (ev as MessageEvent).data;
          if (data) handleEvent(data);
          finishPending(assistantId);
          done();
        };
        es.addEventListener("done", terminal);
        es.addEventListener("complete", terminal);
        es.addEventListener("response.completed", terminal);
        es.addEventListener("run.completed", terminal);

        es.addEventListener("error", (ev) => {
          const data = (ev as MessageEvent).data;
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (parsed?.message && !gotAny) {
                finishPending(assistantId, `⚠ ${parsed.message}`);
              }
            } catch {
              /* connection-level error with no body */
            }
          }
          // EventSource fires `error` on normal stream close too. If we
          // received content, treat it as a clean finish.
          if (es.readyState === EventSource.CLOSED || gotAny) {
            finishPending(assistantId);
            done();
          }
        });
      });

      // 3. If the stream produced nothing, fall back to a turn fetch so
      //    the user still gets an answer.
      const current = messagesRef.current.find((m) => m.id === assistantId);
      if (current && current.text.length === 0) {
        await sendTurnFallback(sessionId, text, assistantId);
      }
    },
    [appendToPending, finishPending, sendTurnFallback],
  );

  // Keep a ref of messages so the post-stream fallback can inspect them
  // without re-creating sendStreaming on every render.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || status !== "ready") return;
    const sessionId = getWaspSessionId();
    if (!sessionId) {
      setStatus("unavailable");
      setStatusMessage("Session expired — sign in again.");
      return;
    }

    setInput("");
    setSending(true);

    const userMsg: Message = { id: nextId(), role: "user", text };
    const assistantId = nextId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      text: "",
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      await sendStreaming(sessionId, text, assistantId);
    } catch {
      finishPending(assistantId, "⚠ Alfred could not respond.");
    } finally {
      setSending(false);
    }
  }, [input, sending, status, sendStreaming, finishPending]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col border border-rule">
      {/* Status strip */}
      <div className="flex items-center justify-between border-b border-rule px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{
              background:
                status === "ready"
                  ? "var(--brass)"
                  : status === "checking"
                    ? "#C9A84C80"
                    : "#E06C75",
            }}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            {status === "ready"
              ? "Alfred — connected"
              : status === "checking"
                ? "Connecting…"
                : "Unavailable"}
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => {
              setMessages([]);
              previousResponseId.current = null;
            }}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            New conversation
          </button>
        )}
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
        style={{ minHeight: 320 }}
      >
        {status === "unavailable" && (
          <p
            className="font-body italic text-[14px]"
            style={{ color: "#E06C75" }}
          >
            {statusMessage || "Alfred is not reachable right now."}
          </p>
        )}
        {messages.length === 0 && status !== "unavailable" && (
          <p
            className="font-body italic text-[15px]"
            style={{ color: "var(--marginalia)" }}
          >
            Ask Alfred anything — about your vault, your matters, or what to
            do next.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className="max-w-[80%] whitespace-pre-wrap px-4 py-3 font-body text-[15px]"
              style={{
                border: "1px solid var(--rule)",
                background:
                  m.role === "user" ? "var(--rule)" : "transparent",
                color: "var(--ink)",
              }}
            >
              <div
                className="mb-1 font-mono text-[9px] uppercase tracking-[0.22em]"
                style={{ color: "var(--brass)" }}
              >
                {m.role === "user" ? "You" : "Alfred"}
              </div>
              {m.text ||
                (m.pending ? (
                  <WorkingDots label={m.note || "Alfred is working"} />
                ) : (
                  ""
                ))}
              {m.pending && m.text && (
                <span
                  className="ml-0.5 inline-block animate-pulse"
                  style={{ color: "var(--brass)" }}
                >
                  ▌
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-rule p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              status === "ready"
                ? "Message Alfred… (Enter to send, Shift+Enter for a new line)"
                : "Chat is unavailable"
            }
            disabled={status !== "ready" || sending}
            rows={2}
            className="flex-1 resize-none bg-transparent px-3 py-2 font-body text-[15px] outline-none"
            style={{ border: "1px solid var(--rule)" }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={status !== "ready" || sending || !input.trim()}
            className="btn-ghost"
            style={{ opacity: status !== "ready" || sending ? 0.5 : 1 }}
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
