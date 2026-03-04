/**
 * alfred-learn-observer hook — watches assistant messages for routing
 * patterns and writes observation queue entries for learning feedback.
 *
 * Trigger: message events where action='sent' (assistant messages)
 *
 * When a routing pattern is detected, appends a structured observation
 * to /mnt/encrypted/alfred/observation-queue.jsonl for downstream
 * learning pipeline consumption.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// --- Per-session buffer (tracks last user message) ---
const sessions = new Map();

// Detection patterns for routing/classification actions
const ROUTING_PATTERNS = [
  /(?:filed?|moved?|put(?:ting)?|categori[sz]ed?|routed?|assigned?)\s+(?:under|to|in|as)/i,
  /(?:belongs?\s+in|this\s+is\s+a[n]?\s+\w+\s+(?:for|about|from))/i,
  /(?:created|wrote|saved)\s+.*(?:vault|task\/|event\/|note\/|person\/)/i,
];

const QUEUE_PATH = "/mnt/encrypted/alfred/observation-queue.jsonl";

function matchesRoutingPattern(content) {
  return ROUTING_PATTERNS.some((re) => re.test(content));
}

const handler = async (event) => {
  // Only handle message events
  if (event.type !== "message") return;
  const { action, sessionKey, context } = event;
  if (!sessionKey) return;

  // Track user messages so we can pair them with assistant responses
  if (action === "received" && context?.content) {
    sessions.set(sessionKey, {
      userInput: String(context.content),
      at: new Date().toISOString(),
    });
    return;
  }

  // Only process assistant messages
  if (action !== "sent") return;
  if (!context?.content || context?.success === false) return;

  const content = String(context.content);

  // Check if the assistant message contains a routing pattern
  if (!matchesRoutingPattern(content)) return;

  // Build observation entry
  const lastUser = sessions.get(sessionKey);
  const observation = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    session_key: sessionKey,
    user_input: lastUser?.userInput ?? null,
    alfred_response: content,
    source: "chat",
  };

  // Ensure queue directory exists
  const queueDir = dirname(QUEUE_PATH);
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }

  appendFileSync(QUEUE_PATH, JSON.stringify(observation) + "\n", "utf-8");
};

export default handler;
