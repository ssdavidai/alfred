import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { VAULT_PATH, IGNORE_DIRS, walkMd, readRecord } from "./vault.js";

// ---------------------------------------------------------------------------
// POST /api/v1/context/cross-channel  (#629)
//
// "What's happening on this tenant in the last N hours" — a single
// cheap fetch the main agent can call instead of fanning out into a
// dozen vault list / search calls when Sir asks for cross-channel
// situational awareness.
//
// Implementation details
//   - Scans vault directories ``event/``, ``conversation/``, ``session/``
//     because the zero-LLM stream-vault pipeline (#394) lands every
//     inbound event as a record with ``stream_type: <slack|plane|...>``
//     in frontmatter under one of those three roots.
//   - Filters by file mtime against ``now - lookback_hours``. Frontmatter
//     also carries ``created`` but we trust mtime for the lookback gate
//     because it's the cheapest filter (no need to parse YAML for files
//     we don't care about).
//   - Groups records by their declared ``stream_type`` and (for slack/
//     sms) by their ``thread_ts`` / ``thread_key`` to produce
//     thread-level counts where applicable.
//   - Caps each channel at ``MAX_ITEMS_PER_CHANNEL`` (50) so high-traffic
//     tenants don't blow the agent's context window with a 5 000-line
//     response. The cap is applied AFTER mtime sort (newest first), so
//     the "summaries" preview always shows the most recent activity.
//   - Active matters / persons are derived from wikilink references
//     (``[[matter/...]]``, ``[[person/...]]``) inside the bodies of the
//     scanned records. Deduped + capped at 25 each.
//   - Zero-LLM. Returns facts; the agent summarises if Sir asks for
//     prose. Average response is well under 50 KB even with the cap
//     hit.
// ---------------------------------------------------------------------------

const DEFAULT_CHANNELS = ["slack", "plane", "email", "voice", "sms", "omi"] as const;
const SCAN_DIRS = ["event", "conversation", "session"] as const;
const MAX_ITEMS_PER_CHANNEL = 50;
const MAX_ENTITIES = 25;
const MAX_LOOKBACK_HOURS = 24 * 30; // 30 days — guard against runaway scans

// stream_type → channel-bucket. Frontmatter values are normalised to
// lowercase before lookup. Multiple stream_types collapse into a single
// agent-facing channel (e.g. ``voice-call`` + ``voice-call-outbound``
// → ``voice``).
const STREAM_TO_CHANNEL: Record<string, string> = {
  slack: "slack",
  "slack-message": "slack",
  plane: "plane",
  "plane-issue": "plane",
  "plane-comment": "plane",
  email: "email",
  agentmail: "email",
  gmail: "email",
  voice: "voice",
  "voice-call": "voice",
  "voice-call-outbound": "voice",
  sms: "sms",
  "sms-inbound": "sms",
  "sms-outbound": "sms",
  "sms-phone": "sms",
  omi: "omi",
  "omi-conversation": "omi",
};

interface ScannedRecord {
  relPath: string;
  mtimeMs: number;
  fm: Record<string, unknown>;
  body: string;
  channel: string;
}

interface ChannelBucket {
  count: number;
  summaries: Array<{
    path: string;
    summary: string;
    at: string;
    stream_type: string;
  }>;
  // Slack/sms-specific: thread-level grouping from frontmatter.
  threads?: Set<string>;
  // Email-specific: subjects from frontmatter ``subject``/``name``.
  subjects?: string[];
  // Voice-specific: total duration from frontmatter ``duration_seconds``.
  duration_seconds?: number;
}

function classifyChannel(streamType: string): string | null {
  if (!streamType) return null;
  const normalised = streamType.toLowerCase();
  if (STREAM_TO_CHANNEL[normalised]) return STREAM_TO_CHANNEL[normalised];
  // Fallback: prefix match (e.g. ``slack-foo`` → slack)
  for (const [prefix, ch] of Object.entries(STREAM_TO_CHANNEL)) {
    if (normalised.startsWith(prefix)) return ch;
  }
  return null;
}

function fmString(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function fmNumber(fm: Record<string, unknown>, key: string): number {
  const v = fm[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Wikilink extractor. Matches [[matter/slug]] and [[matter/slug|alias]]
// shapes — the slug is the canonical reference. Anchors (#section) are
// stripped because entities don't carry them.
const WIKILINK_RE = /\[\[([a-z]+\/[^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]/gi;

function extractWikilinks(body: string, prefix: string): string[] {
  const out = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const ref = m[1];
    if (ref.toLowerCase().startsWith(prefix + "/")) {
      // Normalise to the canonical ``<prefix>/<slug>.md`` form so the
      // dashboard can deep-link straight to the vault file. The wikilink
      // is allowed to omit ``.md`` so we re-add it conditionally.
      const normalised = ref.endsWith(".md") ? ref : `${ref}.md`;
      out.add(normalised);
    }
  }
  return [...out];
}

export function registerContextRoutes(): void {
  addRoute("POST", "/api/v1/context/cross-channel", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;

    // ── parse + validate inputs ────────────────────────────────────────
    let lookbackHours = 24;
    if (b.lookback_hours != null) {
      const n = Number(b.lookback_hours);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError("lookback_hours must be a positive number");
      }
      lookbackHours = Math.min(n, MAX_LOOKBACK_HOURS);
    }

    let channels: string[] = [...DEFAULT_CHANNELS];
    if (b.channels !== undefined) {
      if (!Array.isArray(b.channels)) {
        throw new ValidationError("channels must be a string array");
      }
      const normalised = b.channels.map((c) => String(c).toLowerCase().trim()).filter(Boolean);
      if (normalised.length === 0) {
        throw new ValidationError("channels must contain at least one entry");
      }
      channels = normalised;
    }
    const channelSet = new Set(channels);

    const now = new Date();
    const cutoffMs = now.getTime() - lookbackHours * 3600 * 1000;

    // ── scan vault directories ─────────────────────────────────────────
    const scanned: ScannedRecord[] = [];
    for (const dir of SCAN_DIRS) {
      const fullDir = path.join(VAULT_PATH, dir);
      let relPaths: string[];
      try {
        relPaths = walkMd(fullDir, VAULT_PATH, IGNORE_DIRS);
      } catch {
        continue;
      }
      for (const relPath of relPaths) {
        let mtimeMs: number;
        try {
          const st = fs.statSync(path.join(VAULT_PATH, relPath));
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoffMs) continue;
        const rec = readRecord(relPath);
        if (!rec) continue;
        const streamType = fmString(rec.fm, "stream_type");
        const channel = classifyChannel(streamType);
        if (!channel) continue;
        if (!channelSet.has(channel)) continue;
        scanned.push({
          relPath,
          mtimeMs,
          fm: rec.fm,
          body: rec.body,
          channel,
        });
      }
    }

    // Newest first — keeps the per-channel summaries focused on recent
    // activity once the cap is applied.
    scanned.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // ── group into channel buckets ─────────────────────────────────────
    const buckets: Record<string, ChannelBucket> = {};
    for (const ch of channels) {
      buckets[ch] = { count: 0, summaries: [] };
    }

    const personRefs = new Set<string>();
    const matterRefs = new Set<string>();

    for (const rec of scanned) {
      const bucket = buckets[rec.channel];
      if (!bucket) continue;
      bucket.count += 1;
      if (bucket.summaries.length < MAX_ITEMS_PER_CHANNEL) {
        bucket.summaries.push({
          path: rec.relPath,
          summary:
            fmString(rec.fm, "summary") ||
            fmString(rec.fm, "name") ||
            rec.body.split("\n").find((l) => l.trim().length > 0) ||
            "",
          at: new Date(rec.mtimeMs).toISOString(),
          stream_type: fmString(rec.fm, "stream_type"),
        });
      }
      // Channel-specific aggregates
      if (rec.channel === "slack" || rec.channel === "sms") {
        const threadKey =
          fmString(rec.fm, "thread_ts") ||
          fmString(rec.fm, "thread_key") ||
          fmString(rec.fm, "thread_id");
        if (threadKey) {
          (bucket.threads ??= new Set<string>()).add(threadKey);
        }
      }
      if (rec.channel === "email") {
        const subj = fmString(rec.fm, "subject") || fmString(rec.fm, "name");
        if (subj && (bucket.subjects ??= []).length < MAX_ITEMS_PER_CHANNEL) {
          bucket.subjects.push(subj);
        }
      }
      if (rec.channel === "voice") {
        const dur = fmNumber(rec.fm, "duration_seconds");
        if (dur > 0) {
          bucket.duration_seconds = (bucket.duration_seconds ?? 0) + dur;
        }
      }

      // Wikilink harvest — only walk records once.
      for (const ref of extractWikilinks(rec.body, "matter")) matterRefs.add(ref);
      for (const ref of extractWikilinks(rec.body, "person")) personRefs.add(ref);
    }

    // ── build response shape ───────────────────────────────────────────
    const channelsOut: Record<string, Record<string, unknown>> = {};
    for (const ch of channels) {
      const bucket = buckets[ch];
      const out: Record<string, unknown> = {
        count: bucket.count,
        summaries: bucket.summaries,
      };
      if (bucket.threads) out.thread_count = bucket.threads.size;
      if (bucket.subjects) out.subjects = bucket.subjects;
      if (bucket.duration_seconds !== undefined) {
        out.duration_minutes = Math.round(bucket.duration_seconds / 60);
      }
      channelsOut[ch] = out;
    }

    sendJson(res, 200, {
      lookback_hours: lookbackHours,
      now: now.toISOString(),
      channels: channelsOut,
      active_matters: [...matterRefs].slice(0, MAX_ENTITIES),
      active_persons: [...personRefs].slice(0, MAX_ENTITIES),
      truncated: {
        per_channel_cap: MAX_ITEMS_PER_CHANNEL,
        entity_cap: MAX_ENTITIES,
      },
    });
  });
}
