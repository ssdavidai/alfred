/**
 * alfred-learn-observer hook — watches assistant messages for routing
 * patterns and writes observation queue entries for learning feedback.
 *
 * Trigger: message events (action='received' to buffer user input,
 * action='sent' to detect routing patterns in assistant responses).
 *
 * When a routing pattern is detected, appends a structured observation
 * to the observation queue JSONL file for downstream learning pipeline
 * consumption.
 */

const { randomUUID } = require("crypto");
const { appendFileSync, mkdirSync } = require("fs");
const { dirname } = require("path");

const QUEUE_PATH = process.env.OBSERVATION_QUEUE_PATH || "/alfred-data/observation-queue.jsonl";

// Detection patterns for routing/classification actions
const ROUTING_PATTERNS = [
  /(?:filed?|moved?|put(?:ting)?|categori[sz]ed?|routed?|assigned?)\s+(?:under|to|in|as)/i,
  /(?:belongs?\s+in|this\s+is\s+a[n]?\s+\w+\s+(?:for|about|from))/i,
  /(?:created|wrote|saved)\s+.*(?:vault|task\/|event\/|note\/|person\/)/i,
];

// Per-session buffer (tracks last user message)
const sessions = new Map();

const handler = async (event) => {
  if (event.type !== "message") return;

  const sessionKey = event.sessionKey || "default";
  const content = String(event.context?.content || "");

  // Track user messages so we can pair them with assistant responses
  if (event.action === "received") {
    sessions.set(sessionKey, { userInput: content, at: Date.now() });

    // Prune old sessions to prevent memory leaks
    if (sessions.size > 100) {
      const oldest = [...sessions.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, sessions.size - 100);
      for (const [key] of oldest) sessions.delete(key);
    }
    return;
  }

  // Only process assistant messages
  if (event.action !== "sent") return;

  // Check if the assistant message contains a routing pattern
  const matched = ROUTING_PATTERNS.some((p) => p.test(content));
  if (!matched) return;

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

  // Ensure queue directory exists and append observation
  mkdirSync(dirname(QUEUE_PATH), { recursive: true });
  appendFileSync(QUEUE_PATH, JSON.stringify(observation) + "\n");
};

module.exports = { handler };
