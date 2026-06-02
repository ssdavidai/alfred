// ============================================================================
// alfredJournal.ts — HTTP surface for the one-Alfred continuity layer.
//
// DB helpers live in src/db/alfredJournal.ts so they can be unit-tested in
// isolation from server.ts (which side-effects on import — mkdir of stream
// dirs, etc.). This file is HTTP-only: validate, dispatch, sendJson.
//
// See docs/design/one-alfred.md for the full architecture and
// migrations/0002_alfred_journal.sql for the schema.
//
//   POST   /api/v1/alfred-journal             append an entry
//   GET    /api/v1/alfred-journal/recent      most-recent N for a scope (hot
//                                              path for the Hermes hook)
//   POST   /api/v1/alfred-journal/principal/bind
//                                              (channel, chat_id) → principal_id
//
// FAIL-SOFT for GET /recent: the Hermes pre_gateway_dispatch hook blocks on
// this call, so 5xx here would block Sir's reply from reaching main. The
// helpers below never throw for a normal lookup; errors propagate to
// handleError only on a real DB-level fault.
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  appendJournal,
  bindPrincipalChannel,
  queryRecentJournal,
  type Direction,
  type Status,
} from "../../db/alfredJournal.js";

const VALID_DIRECTIONS: ReadonlySet<Direction> = new Set([
  "outbound",
  "inbound",
]);
const VALID_STATUSES: ReadonlySet<Status> = new Set([
  "pending",
  "delivered",
  "failed",
  "received",
]);

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return null;
  return v.length > 0 ? v : null;
}

export function registerAlfredJournalRoutes(): void {
  // POST /api/v1/alfred-journal — append one entry.
  addRoute("POST", "/api/v1/alfred-journal", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;

    const channel = asString(b.channel, "channel");
    const chatId = asString(b.chat_id, "chat_id");
    const direction = asString(b.direction, "direction") as Direction;
    if (!VALID_DIRECTIONS.has(direction)) {
      throw new ValidationError(
        `direction must be 'outbound' or 'inbound' (got ${JSON.stringify(direction)})`,
      );
    }
    const message = asString(b.message, "message");

    let status: Status | undefined;
    if (b.status !== undefined && b.status !== null) {
      const s = String(b.status);
      if (!VALID_STATUSES.has(s as Status)) {
        throw new ValidationError(
          `status must be one of: pending, delivered, failed, received`,
        );
      }
      status = s as Status;
    }

    let metadata: Record<string, unknown> | null = null;
    if (b.metadata && typeof b.metadata === "object") {
      metadata = b.metadata as Record<string, unknown>;
    }

    const db = getStateDb();
    const entry = appendJournal(db, {
      channel,
      chat_id: chatId,
      direction,
      message,
      source_kind: asOptionalString(b.source_kind),
      source_ref: asOptionalString(b.source_ref),
      hermes_session_id: asOptionalString(b.hermes_session_id),
      hermes_profile: asOptionalString(b.hermes_profile),
      status,
      delivery_error: asOptionalString(b.delivery_error),
      metadata,
      principal_id: asOptionalString(b.principal_id),
    });

    sendJson(res, 201, entry);
  });

  // GET /api/v1/alfred-journal/recent?channel=…&chat_id=…&limit=…&within_hours=…[&profile=…]
  //   OR ?principal_id=…&limit=…&within_hours=…[&profile=…]
  //
  // Hot path: the Hermes pre_gateway_dispatch hook calls this on every
  // inbound message. Indexed query, <5ms typical.
  //
  // Lane IV — optional `profile` filter so the One-Alfred plugin can pull
  // only the target profile's continuity. When omitted, every profile's
  // history is returned (legacy behaviour, no regression for `main`-only
  // tenants). Pass `profile=<slug>` to scope. Special token `profile=__none__`
  // returns only pre-Lane-IV rows (hermes_profile IS NULL).
  addRoute("GET", "/api/v1/alfred-journal/recent", async ({ res, query }) => {
    const limit = Number(query.get("limit") ?? 20);
    const withinHours = Number(query.get("within_hours") ?? 24);

    const principalId = query.get("principal_id");
    const channel = query.get("channel");
    const chatId = query.get("chat_id");
    const profileParam = query.get("profile");

    if (!principalId && !(channel && chatId)) {
      throw new ValidationError(
        "must provide principal_id OR (channel + chat_id)",
      );
    }

    // Translate the URL param into queryRecentJournal's hermes_profile arg.
    //   missing  → undefined → no scoping
    //   __none__ → null      → hermes_profile IS NULL (pre-Lane-IV rows only)
    //   <slug>   → <slug>    → exact match
    let hermesProfile: string | null | undefined;
    if (profileParam === null) {
      hermesProfile = undefined;
    } else if (profileParam === "__none__") {
      hermesProfile = null;
    } else {
      hermesProfile = profileParam;
    }

    const db = getStateDb();
    const entries = principalId
      ? queryRecentJournal(db, { principal_id: principalId }, {
          limit,
          within_hours: withinHours,
          hermes_profile: hermesProfile,
        })
      : queryRecentJournal(
          db,
          { channel: channel as string, chat_id: chatId as string },
          { limit, within_hours: withinHours, hermes_profile: hermesProfile },
        );

    sendJson(res, 200, {
      entries,
      count: entries.length,
      window: {
        limit,
        within_hours: withinHours,
        ...(profileParam !== null ? { profile: profileParam } : {}),
      },
    });
  });

  // POST /api/v1/alfred-journal/principal/bind — idempotent (channel, chat_id) → principal_id.
  addRoute(
    "POST",
    "/api/v1/alfred-journal/principal/bind",
    async ({ res, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const channel = asString(b.channel, "channel");
      const chatId = asString(b.chat_id, "chat_id");
      const principalId = asString(b.principal_id, "principal_id");

      const db = getStateDb();
      const exists = db
        .prepare("SELECT id FROM alfred_principal WHERE id = ?")
        .get(principalId) as { id?: string } | undefined;
      if (!exists?.id) {
        throw new ValidationError(
          `unknown principal_id '${principalId}' — create the principal row first`,
        );
      }

      bindPrincipalChannel(db, channel, chatId, principalId);
      sendJson(res, 200, {
        ok: true,
        channel,
        chat_id: chatId,
        principal_id: principalId,
      });
    },
  );
}
