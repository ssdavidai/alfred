// haConversationCardCore — pure shape derivation for the /channels
// "HA → Alfred (conversation)" setup card (#111 PR3).
//
// Card A in the Wave-C twofer with VoiceWakeWordsCard. This card is
// mostly a documentation surface: it walks the principal through the
// three-step install of the ssdavidai/alfred-ha HACS custom component,
// then lists the channel tokens that have been minted for each HA
// install. There is no runtime status to derive — HA is the side that
// CALLS ctrl-api (POST /api/v1/channels/ha/turn), so the card's job is
// to publish the install ritual and surface the persisted tokens.
//
// Backed by:
//   * GET  /api/v1/channel-tokens?channel=ha-conversation     (PR #111 PR1)
//   * POST /api/v1/channel-tokens/mint                        (PR #111 PR1)
//   * POST /api/v1/channel-tokens/:id/revoke                  (PR #111 PR1)
//
// Import-free (no React, no Wasp) so the helpers unit-test under
// node:test the same way the other ChannelsPage cores do.

/** The single source of truth for "where is the HACS custom repo?".
 *  Surfaced as a copyable string on the card. The principal pastes it
 *  into HACS → ⋮ → Custom repositories → Repository. */
export function buildHacsRepoUrl(): string {
  return "https://github.com/ssdavidai/alfred-ha";
}

/** UUID v4 regex (loose — only checks shape + version nibble). HA's
 *  built-in `instance_id` is a uuid4, which is the default we recommend.
 *  Any v4-shaped string passes. Empty / whitespace fails. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Slug regex for "human-readable HA install" labels (e.g. "home-kitchen"
 *  or "vacation-house"). Mirrors the GitHub-slug / docker-name shape: the
 *  characters that survive YAML + URL paths without quoting. */
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/** Accept a uuid v4 OR a plain installation slug (`a-zA-Z0-9_-`,
 *  8-64 chars). Returns the normalised value on success; null on
 *  failure. Used by the mint-token form input to refuse footguns
 *  (whitespace, control chars, accidental quoted strings) at the UI
 *  layer rather than leaving it for ctrl-api to reject. */
export function parseHaInstallId(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (UUID_V4_RE.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.length < 8 || trimmed.length > 64) return null;
  if (!SLUG_RE.test(trimmed)) return null;
  return trimmed;
}

/** The public-safe channel-token shape we read off ctrl-api's
 *  `GET /api/v1/channel-tokens?channel=ha-conversation`. Mirrors
 *  `ChannelTokenMeta` in packages/ctrl/src/db/channelTokens.ts — but
 *  duplicated here as a literal type so the web package doesn't have
 *  to import from ctrl. */
export interface ChannelTokenRow {
  id: string;
  channel: string;
  label: string | null;
  scope: Record<string, unknown> | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  rotated_from: string | null;
  revoked_at: number | null;
}

/** One row in the "Installed HA installs" table. The card's render
 *  layer reads this shape directly. `installId` is read from the
 *  channel-token's `scope.haInstanceId` (which the mint flow populates
 *  by parsing the form input through `parseHaInstallId`); if the scope
 *  is missing or malformed we fall back to the row id so the row is
 *  never invisible. */
export interface HaInstalledInstall {
  /** The ULID of the channel-token row — used as a React key + the
   *  argument to /channel-tokens/:id/revoke. */
  tokenId: string;
  /** The principal's identifier for this HA install. Read from
   *  scope.haInstanceId; never null (falls back to tokenId). */
  installId: string;
  /** The human-friendly label the principal supplied at mint
   *  (typically `ha:<installId>` per the migration's example). May be
   *  null when an older mint omitted it. */
  label: string | null;
  /** Unix ms; null until the token is first used by HA. */
  lastUsedAt: number | null;
  /** Best-effort source IP recorded by ctrl-api on the most recent
   *  authenticated request. Null when never used. */
  lastUsedIp: string | null;
}

export interface HaInstallsSummary {
  installs: HaInstalledInstall[];
}

/** Read the `haInstanceId` scope field defensively. The scope_json is
 *  channel-defined free-form: a malformed string, a non-object, or a
 *  missing key all fall back to null so the table renders something
 *  rather than throwing. */
function readInstallId(scope: Record<string, unknown> | null): string | null {
  if (!scope || typeof scope !== "object") return null;
  const v = (scope as Record<string, unknown>).haInstanceId;
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

/** Group ha-conversation channel-token rows into the install-table
 *  shape the card renders. Filters out tokens for other channels (the
 *  endpoint should already do this, but defence-in-depth is cheap),
 *  filters out revoked tokens (their "row" is the audit, not the
 *  table), and sorts by created_at descending so newest installs
 *  appear at the top. */
export function summariseInstalledHaTokens(
  tokens: ChannelTokenRow[] | null | undefined,
): HaInstallsSummary {
  if (!Array.isArray(tokens)) return { installs: [] };
  const filtered = tokens.filter(
    (t) => t && t.channel === "ha-conversation" && t.revoked_at == null,
  );
  // Sort newest-first by created_at, with stable fallback on id.
  const sorted = [...filtered].sort((a, b) => {
    const ca = typeof a.created_at === "number" ? a.created_at : 0;
    const cb = typeof b.created_at === "number" ? b.created_at : 0;
    if (cb !== ca) return cb - ca;
    return a.id.localeCompare(b.id);
  });
  const installs: HaInstalledInstall[] = sorted.map((t) => ({
    tokenId: t.id,
    installId: readInstallId(t.scope) ?? t.id,
    label: t.label,
    lastUsedAt: typeof t.last_used_at === "number" ? t.last_used_at : null,
    lastUsedIp: typeof t.last_used_ip === "string" ? t.last_used_ip : null,
  }));
  return { installs };
}

/** Truncate a long install id for table-cell display. Keeps the head +
 *  ellipsis + tail so the principal can tell two installs apart at a
 *  glance without the cell overflowing. */
export function truncateInstallId(value: string, max = 16): string {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  const head = Math.max(4, Math.floor((max - 1) / 2));
  const tail = Math.max(3, max - 1 - head);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Format a unix-ms timestamp as a "Last used N ago" string. Null →
 *  "Never". Now-vs-then comparison is done against a frozen `now` so
 *  tests are deterministic. */
export function formatLastUsed(
  unixMs: number | null,
  now: Date = new Date(),
): string {
  if (unixMs == null) return "Never";
  const deltaSec = Math.floor((now.getTime() - unixMs) / 1000);
  if (deltaSec < 0) return "Just now";
  if (deltaSec < 60) return "Just now";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} min ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)} h ago`;
  return `${Math.floor(deltaSec / 86_400)} d ago`;
}
