/**
 * Hook: alfred-learn-observer
 *
 * Watches for routing patterns in Alfred's responses and queues observations
 * for the Learning workflow. Deployed alongside alfred-inbox in the hooks directory.
 *
 * Detection: When Alfred's assistant message contains routing language
 * (e.g. "filed under", "moved to", "categorized as"), the hook writes an
 * observation request to /mnt/encrypted/alfred/observation-queue.jsonl.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROUTING_PATTERNS = [
  /(?:filed?|moved?|put(?:ting)?|categori[sz]ed?|routed?|assigned?)\s+(?:under|to|in|as)/i,
  /(?:belongs?\s+in|this\s+is\s+a[n]?\s+\w+\s+(?:for|about|from))/i,
  /(?:created|wrote|saved)\s+.*(?:vault|task\/|event\/|note\/|person\/)/i,
];

const OBSERVATION_QUEUE_PATH =
  process.env.OBSERVATION_QUEUE_PATH ||
  "/mnt/encrypted/alfred/observation-queue.jsonl";

// In-memory buffer of recent user messages per session
const userMessageBuffer = new Map();

/**
 * Track the last user message for a session.
 */
function trackUserMessage(sessionKey, content) {
  userMessageBuffer.set(sessionKey, {
    content,
    timestamp: new Date().toISOString(),
  });

  // Prune old entries (keep last 100 sessions)
  if (userMessageBuffer.size > 100) {
    const oldest = userMessageBuffer.keys().next().value;
    userMessageBuffer.delete(oldest);
  }
}

/**
 * Get the last user message for a session.
 */
function getLastUserMessage(sessionKey) {
  const entry = userMessageBuffer.get(sessionKey);
  return entry ? entry.content : null;
}

/**
 * Append a record to the observation queue JSONL file.
 */
function appendToJsonl(filePath, record) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}

/**
 * Main hook handler.
 *
 * @param {object} event - The hook event from OpenClaw
 * @param {string} event.type - "message"
 * @param {string} event.action - "sent" | "received"
 * @param {string} event.sessionKey - Session identifier
 * @param {object} event.context - Message context
 * @param {string} event.context.content - Message content
 * @param {string} event.context.role - "user" | "assistant"
 */
const handler = async (event) => {
  if (!event || event.type !== "message") return;

  const content = String(event.context?.content || "");
  const sessionKey = event.sessionKey || "unknown";

  // Track user messages
  if (event.action === "received" && event.context?.role === "user") {
    trackUserMessage(sessionKey, content);
    return;
  }

  // Only process assistant sent messages
  if (event.action !== "sent") return;

  // Check for routing patterns
  const matched = ROUTING_PATTERNS.some((p) => p.test(content));
  if (!matched) return;

  // Get the user message that triggered this
  const userMessage = getLastUserMessage(sessionKey);
  if (!userMessage) return;

  const observation = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    session_key: sessionKey,
    user_input: userMessage,
    alfred_response: content,
    source: "chat",
  };

  try {
    appendToJsonl(OBSERVATION_QUEUE_PATH, observation);
  } catch (err) {
    console.error("[alfred-learn-observer] Failed to write observation:", err.message);
  }
};

module.exports = { handler, ROUTING_PATTERNS };
