// Pure response-shaping helpers for the dashboard activity feed.

export type ActivityTool = "curator" | "janitor" | "distiller" | "surveyor" | "system";
export type ActivityLevel = "info" | "warning" | "error";

export interface ActivityItem {
  timestamp: string;
  tool: ActivityTool;
  level: ActivityLevel;
  event: string;
  message: string;
  actionType: string;
  correlationRef: string | null;
}

export interface ActivityEnvelope {
  items: ActivityItem[];
  generatedAt: string | null;
  partial: boolean;
  failedSources: string[];
}

const TOOLS = new Set<ActivityTool>(["curator", "janitor", "distiller", "surveyor", "system"]);
const LEVELS = new Set<ActivityLevel>(["info", "warning", "error"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function correlationRef(item: Record<string, unknown>): string | null {
  let payload = record(item.payload);
  try {
    if (!Object.keys(payload).length && text(item.payload_json)) {
      payload = record(JSON.parse(text(item.payload_json)));
    }
  } catch { /* Fall through to the row-level correlation reference. */ }
  return text(payload.correlation_id) || text(item.correlation_id) || text(item.subject_ref) || null;
}

export function parseActivityEnvelope(value: unknown): ActivityEnvelope {
  const envelope = record(value);
  const partial = envelope.partial === true;
  const failedSources = (Array.isArray(envelope.sources) ? envelope.sources : [])
    .map(record)
    .filter((source) => source.ok === false)
    .map((source) => text(source.name))
    .filter(Boolean);
  const items = (Array.isArray(envelope.items) ? envelope.items : []).map((value) => {
    const item = record(value);
    const tool = text(item.tool) as ActivityTool;
    const level = text(item.level) as ActivityLevel;
    const event = text(item.event) || text(item.action_type) || "activity";
    return {
      timestamp: text(item.timestamp) || text(item.ts),
      tool: TOOLS.has(tool) ? tool : "system",
      level: LEVELS.has(level) ? level : "info",
      event,
      message: text(item.message) || text(item.summary) || event,
      actionType: text(item.action_type) || event,
      correlationRef: correlationRef(item),
    };
  });
  return {
    items,
    generatedAt: text(envelope.generated_at) || null,
    partial,
    failedSources: failedSources.length || !partial ? failedSources : ["unknown source"],
  };
}

export function formatActivityFreshness(generatedAt: string | null): string {
  return generatedAt ? `as of ${generatedAt}` : "freshness unavailable";
}

export function selectActivityFeedState(envelope: ActivityEnvelope): "ready" | "empty" | "degraded" {
  return envelope.partial ? "degraded" : envelope.items.length ? "ready" : "empty";
}
