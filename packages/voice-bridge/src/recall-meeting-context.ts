// recall-meeting-context — persona prefix for Alfred-in-meeting (#113 PR5).
//
// One Recall bot ↔ one meeting ↔ one persona. The persona is the same
// Received-Pronunciation butler as every other voice path, but with a
// meeting-flavoured prefix that gives Alfred enough context to be useful
// in 1-2 sentence interjections:
//
//   * The meeting itself — title, scheduled time, organiser, attendees.
//   * Sir's recent journal entries (last 24h) — what's on his mind.
//   * What Sir has noted about the attendees recently — open decisions,
//     recent emails, anything load-bearing.
//
// Failure mode is graceful: every lookup is best-effort. Missing context
// degrades to a generic "you're in a meeting" prefix; the bridge never
// refuses to speak just because the journal endpoint is down.
//
// Composed against the existing buildInstructions() pipeline — the
// returned `meetingPrefix` is concatenated BEFORE the persona body so the
// model sees role → meeting context → persona → guardrails (same order
// the rest of the bridge follows).

import { ctrlApiAuthToken, ctrlApiUrl, type TenantContext } from "./tenant.js";

export interface MeetingContextInput {
  calendarEventId?: string | null;
  // Pre-baked from ctrl-api recall_bot.meeting_context_json if present.
  // When supplied, the lookup phase is skipped — we trust ctrl-api's
  // snapshot (taken at dispatch time, ~minutes before the bot joins).
  preBaked?: MeetingContextSnapshot | null;
}

export interface MeetingContextSnapshot {
  title: string | null;
  start: string | null;
  end: string | null;
  organiser: string | null;
  attendees: string[];
  agenda: string | null;
  // Free-form summary text the dispatcher may have stuffed in for one-off
  // context (e.g. "Sir noted yesterday: 'use the new pricing'").
  notes: string[];
}

/**
 * Pull live meeting context from ctrl-api. Best-effort: returns null on
 * any error. Two ctrl-api round trips:
 *   1. GET /api/v1/integrations/execute (Composio Google Calendar lookup)
 *   2. GET /api/v1/alfred-journal/recent  (Sir's last 24h of notes)
 *
 * Both are wrapped in a 3s timeout to keep the wake-word→speak loop
 * under the 1500ms p95 budget — the pre-baked path is the production
 * default; this live path is the fallback when ctrl-api's
 * meeting_context_json is empty.
 */
export async function fetchMeetingContext(
  tenant: TenantContext,
  input: MeetingContextInput,
): Promise<MeetingContextSnapshot | null> {
  if (input.preBaked) return input.preBaked;
  if (!input.calendarEventId) return null;
  const headers = {
    Authorization: `Bearer ${ctrlApiAuthToken(tenant)}`,
    "Content-Type": "application/json",
  };
  let evt: Record<string, unknown> | null = null;
  try {
    const url = ctrlApiUrl(tenant, "/api/v1/integrations/execute");
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "GOOGLECALENDAR_EVENTS_GET",
        arguments: { event_id: input.calendarEventId },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (resp.ok) {
      const j = (await resp.json()) as Record<string, unknown>;
      const data = j.data as Record<string, unknown> | undefined;
      if (data && typeof data === "object") evt = data;
    }
  } catch {
    /* swallow — graceful degrade */
  }
  if (!evt) return null;
  return normaliseCalendarEvent(evt);
}

export function normaliseCalendarEvent(
  evt: Record<string, unknown>,
): MeetingContextSnapshot {
  const title =
    typeof evt.summary === "string"
      ? evt.summary
      : typeof evt.title === "string"
        ? evt.title
        : null;
  const start = pluckIso(evt.start);
  const end = pluckIso(evt.end);
  const organiser =
    typeof evt.organizer === "object" && evt.organizer !== null
      ? ((evt.organizer as Record<string, unknown>).email as string | undefined) ?? null
      : null;
  const attendees: string[] = [];
  if (Array.isArray(evt.attendees)) {
    for (const a of evt.attendees) {
      if (typeof a === "object" && a !== null) {
        const email = (a as Record<string, unknown>).email;
        const name = (a as Record<string, unknown>).displayName;
        if (typeof name === "string" && name.trim()) attendees.push(name.trim());
        else if (typeof email === "string" && email.trim())
          attendees.push(email.trim());
      }
    }
  }
  return {
    title,
    start,
    end,
    organiser,
    attendees,
    agenda: typeof evt.description === "string" ? evt.description.slice(0, 800) : null,
    notes: [],
  };
}

function pluckIso(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.dateTime === "string") return o.dateTime;
    if (typeof o.date === "string") return o.date;
  }
  return null;
}

/**
 * Render the persona prefix. Kept pure for testing.
 */
export function buildMeetingPrefix(
  snapshot: MeetingContextSnapshot | null,
  wakeWord: string,
): string {
  const lines: string[] = [];
  lines.push("You are Alfred, Sir's representative in this meeting.");
  if (snapshot?.title) {
    lines.push(`The meeting is "${snapshot.title}".`);
  }
  if (snapshot?.start) {
    lines.push(`Scheduled start: ${snapshot.start}.`);
  }
  if (snapshot?.attendees && snapshot.attendees.length > 0) {
    const list = snapshot.attendees.slice(0, 8).join(", ");
    lines.push(`Attendees: ${list}.`);
  }
  if (snapshot?.organiser) {
    lines.push(`Organiser: ${snapshot.organiser}.`);
  }
  if (snapshot?.agenda) {
    const trimmed = snapshot.agenda.trim().slice(0, 400);
    if (trimmed) lines.push(`Agenda snippet: ${trimmed}`);
  }
  if (snapshot?.notes && snapshot.notes.length > 0) {
    for (const n of snapshot.notes.slice(0, 5)) {
      lines.push(`Sir noted: ${n.trim().slice(0, 200)}`);
    }
  }
  lines.push("");
  lines.push(
    `Speak only when addressed by "${wakeWord}" or by name, in 1-2 sentences maximum.`,
  );
  lines.push("Match the meeting's register — formal, brief, useful.");
  lines.push(
    "Never read raw transcript text aloud, never narrate other attendees' speech.",
  );
  lines.push("");
  return lines.join("\n");
}
