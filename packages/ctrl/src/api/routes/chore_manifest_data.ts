/**
 * Static manifest of the chore_actions library — the activities that
 * generated chores are allowed to call. Each entry describes:
 *
 *   - what the activity does (1-2 sentences in plain English)
 *   - `reads`: what data the activity consumes (vault type, stream, etc.)
 *   - `writes`: what data the activity produces (vault write, filesystem, notification)
 *   - `llm`: whether the activity makes an LLM call (cost + latency signal)
 *   - `required_data`: prerequisites the tenant must have for the activity
 *     to return non-empty results. This is the anti-hallucination check —
 *     the dashboard renders this so the user can verify the chore isn't
 *     built on data that doesn't actually exist.
 *
 * Kept as a hand-authored static source in ctrl so the dashboard doesn't
 * need a cross-service call to learn. When the chore_actions library
 * changes, update this file. A future improvement would be to have learn
 * emit this manifest as part of its Docker image and have ctrl read it
 * from a shared volume — but for now, hand-maintained.
 */

export interface ChoreActionSpec {
  /** Activity function name — matches what appears in generated Python */
  name: string;
  /** 1-2 sentence plain-English description */
  description: string;
  /** What the activity reads. Empty array if it reads nothing. */
  reads: Array<{
    kind: "vault" | "stream" | "snapshot" | "llm_context";
    resource: string;
    /** How to check whether this data source has anything in it */
    check_path?: string;
  }>;
  /** What the activity writes. Empty array if it writes nothing. */
  writes: Array<{
    kind: "vault" | "snapshot" | "notification" | "llm_output";
    resource: string;
  }>;
  /** Does this activity make an LLM call? (cost + latency signal) */
  llm: boolean;
  /** Prerequisites for the activity to return useful (non-empty) results */
  required_data: string[];
}

export const CHORE_ACTION_MANIFEST: Record<string, ChoreActionSpec> = {
  // ---- Generic primitives — the three passthroughs a chore is composed from.
  // Prefer these over the bespoke activities below. The bespoke ones are kept
  // for backwards compatibility with existing generated chores and will be
  // retired as those chores are rewritten to compose from these primitives.

  call_self: {
    name: "call_self",
    description:
      "HTTP passthrough to the tenant ctrl-api (:3100). Same surface as the `self` MCP tool the main agent uses — list/read/write vault records, fetch streams, trigger sessions, read schedules, etc. Arguments: endpoint (path), method (default GET), body (JSON for writes), query (querystring). Returns parsed JSON. Raises on non-2xx.",
    reads: [
      { kind: "vault", resource: "any ctrl-api endpoint" },
    ],
    writes: [
      { kind: "vault", resource: "any ctrl-api write endpoint" },
    ],
    llm: false,
    required_data: [
      "Works on every tenant — ctrl-api is always running.",
      "Data availability depends on which endpoint the chore calls. Confirm the target endpoint's prerequisites in TOOLS.md before relying on the response shape.",
    ],
  },

  call_composio: {
    name: "call_composio",
    description:
      "Execute any Composio action (Gmail, Calendar, Notion, GitHub, Slack, Stripe, 1000+ others). Wraps ctrl-api `/api/v1/composio/execute`. Arguments: action (action name), arguments (per-action payload). Returns the action result. The skill for each connected app documents its actions + schemas.",
    reads: [
      { kind: "stream", resource: "any Composio-connected app" },
    ],
    writes: [
      { kind: "notification", resource: "any Composio-connected app" },
    ],
    llm: false,
    required_data: [
      "Requires the relevant Composio app to be connected on this tenant (check /api/v1/integrations).",
      "Requires COMPOSIO_API_KEY + COMPOSIO_USER_ID to be set (default on every tenant since PR #428).",
    ],
  },

  spawn_subagent: {
    name: "spawn_subagent",
    description:
      "Fire-and-wait an openclaw-workers subagent with a prompt. Use when a chore step genuinely needs LLM reasoning — filtering / formatting / aggregation should stay in the workflow's Python body instead. Arguments: prompt (string), agent_id (default `learn-clerk`), timeout_s (default 300). Returns the subagent's final text. Subagents on workers run maxConcurrent=1 — two LLM-bearing chores firing the same minute will serialise.",
    reads: [
      { kind: "llm_context", resource: "openclaw-workers subagent on grok-4.1-fast (default)" },
    ],
    writes: [
      { kind: "llm_output", resource: "assistant text reply" },
    ],
    llm: true,
    required_data: [
      "Requires openclaw-workers gateway healthy (check /api/v1/admin/containers).",
      "Default agent learn-clerk is pre-registered on every tenant.",
      "Specialized agents (alfred-vault-curator, alfred-voice, etc.) also available; custom tool sets require a follow-up platform change to register a new agent.",
    ],
  },

  // ---- Bespoke activities (legacy). Retained for backwards compatibility.

  fetch_financial_events: {
    name: "fetch_financial_events",
    description:
      "Walks the vault event directory and returns events from the last N days whose `matter` frontmatter field contains any of the given domains. Pure Python, no LLM.",
    reads: [
      {
        kind: "vault",
        resource: "event/*.md",
        check_path: "vault/event",
      },
    ],
    writes: [],
    llm: false,
    required_data: [
      "Vault must have event records written by the event processor (populated by connected streams like Gmail, Polar, Stripe webhooks).",
      "Each event needs a `matter` frontmatter field matching one of the watched domains (e.g. 'stripe.com', 'polar.sh').",
      "Events need a `date` frontmatter field to filter by age.",
    ],
  },

  load_subscription_snapshot: {
    name: "load_subscription_snapshot",
    description:
      "Loads the previous run's baseline snapshot from disk at /alfred-data/subscription_snapshots/<slug>.json. Returns empty dict on first run.",
    reads: [
      {
        kind: "snapshot",
        resource: "/alfred-data/subscription_snapshots/<chore_slug>.json",
      },
    ],
    writes: [],
    llm: false,
    required_data: [
      "Always safe to call — returns empty dict on first run.",
      "Snapshot is populated by save_subscription_snapshot on previous runs.",
    ],
  },

  save_subscription_snapshot: {
    name: "save_subscription_snapshot",
    description:
      "Persists the current run's events as the new baseline snapshot. Used by subscription_watcher-style chores to detect week-over-week changes.",
    reads: [],
    writes: [
      {
        kind: "snapshot",
        resource: "/alfred-data/subscription_snapshots/<chore_slug>.json",
      },
    ],
    llm: false,
    required_data: [
      "No prerequisites — always writable.",
    ],
  },

  diff_subscriptions: {
    name: "diff_subscriptions",
    description:
      "Computes new charges, removed charges, and amount changes between the current event list and the previous snapshot. Pure Python.",
    reads: [],
    writes: [],
    llm: false,
    required_data: [
      "Requires non-empty event list from fetch_financial_events to produce meaningful diffs.",
    ],
  },

  filter_anomalies_by_threshold: {
    name: "filter_anomalies_by_threshold",
    description:
      "Filters diff output down to the entries above a configurable confidence/anomaly threshold. Pure Python.",
    reads: [],
    writes: [],
    llm: false,
    required_data: [
      "Requires diff output from diff_subscriptions.",
    ],
  },

  ask_alfred_to_judge_anomalies: {
    name: "ask_alfred_to_judge_anomalies",
    description:
      "Escalates filtered anomalies to the OpenClaw agent to decide if the user should be notified. Makes an LLM call only when anomalies are present.",
    reads: [
      {
        kind: "llm_context",
        resource: "vault/matter/*.md for context on the matter being evaluated",
      },
    ],
    writes: [
      {
        kind: "llm_output",
        resource: "verdict dict with should_notify + message fields",
      },
    ],
    llm: true,
    required_data: [
      "OpenClaw gateway must be running and healthy.",
      "OpenRouter or Anthropic API key must be configured.",
      "Only fires when the filter stage returned at least one anomaly.",
    ],
  },

  fetch_matter_events_last_week: {
    name: "fetch_matter_events_last_week",
    description:
      "Returns all events from the last 7 days associated with a specific matter slug. Used by weekly matter digest chores.",
    reads: [
      {
        kind: "vault",
        resource: "event/*.md where frontmatter.matter matches the given slug",
        check_path: "vault/event",
      },
    ],
    writes: [],
    llm: false,
    required_data: [
      "The specified matter slug must exist in vault/matter/.",
      "Events must have been written tagged with that matter (usually by the event processor or curator).",
    ],
  },

  write_matter_digest_via_llm: {
    name: "write_matter_digest_via_llm",
    description:
      "Asks Opus to write a weekly digest summary for a matter based on its recent events. Always makes an LLM call.",
    reads: [
      {
        kind: "llm_context",
        resource: "matter record + event list passed as argument",
      },
    ],
    writes: [
      {
        kind: "llm_output",
        resource: "markdown digest string",
      },
    ],
    llm: true,
    required_data: [
      "OpenClaw gateway must be running.",
      "Non-empty event list from fetch_matter_events_last_week.",
    ],
  },

  save_digest_to_vault: {
    name: "save_digest_to_vault",
    description:
      "Writes a digest as an event vault record tagged `digest`. The daily digest UI surfaces these as `lastDigest` in the learning status endpoint.",
    reads: [],
    writes: [
      {
        kind: "vault",
        resource: "event/digest-<matter>-<date>.md",
      },
    ],
    llm: false,
    required_data: [
      "ctrl-api must be reachable from alfred-learn on http://ctrl-api:3100.",
    ],
  },

  send_chore_notification: {
    name: "send_chore_notification",
    description:
      "Delivers a message through the OpenClaw session manager so it appears in the user's Alfred chat. Used when a chore decides the user should be nudged.",
    reads: [],
    writes: [
      {
        kind: "notification",
        resource: "openclaw session message",
      },
    ],
    llm: false,
    required_data: [
      "OpenClaw gateway must be running on :18789.",
      "A valid session_id must exist (usually 'main' — verified at workflow startup).",
    ],
  },
};

/**
 * Look up manifest entries for a list of activity names. Returns both
 * found entries and unknown names (which would indicate hallucination —
 * the chore references an activity that doesn't exist in the library).
 */
export function lookupChoreActions(names: string[]): {
  found: ChoreActionSpec[];
  unknown: string[];
} {
  const found: ChoreActionSpec[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const spec = CHORE_ACTION_MANIFEST[name];
    if (spec) {
      found.push(spec);
    } else {
      unknown.push(name);
    }
  }
  return { found, unknown };
}
