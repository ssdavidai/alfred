/**
 * alfred-learn-observer hook — watches messages for:
 *   1. Routing patterns in ASSISTANT messages (existing)
 *   2. User instructions, corrections, and confirmations in USER messages (new)
 *
 * Trigger: message events (action='received' for user, action='sent' for assistant).
 *
 * When a pattern is detected, appends a structured observation to the
 * observation queue JSONL file for downstream learning pipeline consumption.
 */

const { randomUUID } = require("crypto");
const { appendFileSync, mkdirSync } = require("fs");
const { dirname } = require("path");

const QUEUE_PATH = process.env.OBSERVATION_QUEUE_PATH || "/alfred-data/observation-queue.jsonl";

// === Detection patterns ===

// ASSISTANT patterns: routing/classification actions (existing, proven)
const ROUTING_PATTERNS = [
  /(?:filed?|moved?|put(?:ting)?|categori[sz]ed?|routed?|assigned?)\s+(?:under|to|in|as)/i,
  /(?:belongs?\s+in|this\s+is\s+a[n]?\s+\w+\s+(?:for|about|from))/i,
  /(?:created|wrote|saved)\s+.*(?:vault|task\/|event\/|note\/|person\/)/i,
];

// USER patterns: instructions that teach Alfred new rules/behaviors
const USER_INSTRUCTION_PATTERNS = [
  // Imperatives: "from now on...", "always...", "whenever...", "every time..."
  /(?:from now on|always|whenever|every time|if you (?:see|get|receive)|when (?:you|I) (?:see|get|receive))\b/i,
  // Rule definitions: "flag X as Y", "route X to Y when Z"
  /(?:flag|route|file|move|send|create|summarize|notify|alert|mark)\s+.+(?:when|if|every|as)\b/i,
];

// USER patterns: corrections to Alfred's previous action
const USER_CORRECTION_PATTERNS = [
  /(?:should (?:have |not )?(?:be|been|go)|next time|instead of)\b/i,
  /(?:that(?:'s| was| is)? (?:wrong|incorrect|not right|not what I))\b/i,
  /(?:don'?t|never|stop doing|stop (?:routing|filing|sending|moving))\b/i,
];

// USER patterns: positive confirmation that Alfred did the right thing
const USER_CONFIRMATION_PATTERNS = [
  /(?:that(?:'s| is) (?:right|correct|good|perfect|exactly|great))\b/i,
  /(?:yes,?\s*(?:like that|keep|do that|exactly|that's it|correct))\b/i,
  /(?:good (?:job|work|call)|well done|keep (?:doing|it up))\b/i,
];

// Minimum content length to consider (avoid matching "yes" as standalone)
const MIN_INSTRUCTION_LENGTH = 15;
const MIN_CORRECTION_LENGTH = 10;
const MIN_CONFIRMATION_LENGTH = 8;

// Per-session buffer (tracks last user + assistant messages for context pairing)
const sessions = new Map();

function appendToQueue(entry) {
  mkdirSync(dirname(QUEUE_PATH), { recursive: true });
  appendFileSync(QUEUE_PATH, JSON.stringify(entry) + "\n");
}

const handler = async (event) => {
  if (event.type !== "message") return;

  const sessionKey = event.sessionKey || "default";
  const content = String(event.context?.content || "");

  if (event.action === "received") {
    // --- USER MESSAGE ---
    const session = sessions.get(sessionKey) || {};

    // Check for instruction/correction/confirmation patterns
    let type = null;
    if (content.length >= MIN_INSTRUCTION_LENGTH && USER_INSTRUCTION_PATTERNS.some((p) => p.test(content))) {
      type = "instruction";
    } else if (content.length >= MIN_CORRECTION_LENGTH && USER_CORRECTION_PATTERNS.some((p) => p.test(content))) {
      type = "correction";
    } else if (content.length >= MIN_CONFIRMATION_LENGTH && USER_CONFIRMATION_PATTERNS.some((p) => p.test(content))) {
      type = "confirmation";
    }

    if (type) {
      appendToQueue({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        session_key: sessionKey,
        user_input: content,
        alfred_response: null,
        assistant_context: session.lastAssistant ?? null,
        source: "chat",
        type,
      });
    }

    // Update session buffer with this user message
    sessions.set(sessionKey, { ...session, userInput: content, at: Date.now() });

    // Prune old sessions to prevent memory leaks
    if (sessions.size > 100) {
      const oldest = [...sessions.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, sessions.size - 100);
      for (const [key] of oldest) sessions.delete(key);
    }
    return;
  }

  if (event.action !== "sent") return;

  // --- ASSISTANT MESSAGE ---
  const session = sessions.get(sessionKey) || {};

  // Track last assistant message for context pairing with future user corrections/confirmations
  sessions.set(sessionKey, { ...session, lastAssistant: content, at: Date.now() });

  // Check if the assistant message contains a routing pattern (existing behavior)
  const matched = ROUTING_PATTERNS.some((p) => p.test(content));
  if (!matched) return;

  const observation = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    session_key: sessionKey,
    user_input: session.userInput ?? null,
    alfred_response: content,
    source: "chat",
    type: "routing",
  };

  appendToQueue(observation);
};

module.exports = { handler };
