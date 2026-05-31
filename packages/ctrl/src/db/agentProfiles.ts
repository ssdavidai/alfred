// agentProfiles — multi-profile Hermes registry helpers (#120 Lane I).
//
// Backed by the `agent_profile` + `channel_profile_binding` tables added in
// 0017_agent_profiles.sql. Pure DB lib — no HTTP, no fs, no docker exec. The
// HTTP surface (routes/profiles.ts) is the only place that translates these
// helper errors into ApiError statuses; everything else (Lane II supervisor,
// Lane IV channel routes) calls these helpers directly.
//
// Port-allocation rule (Contract 2 in /tmp/orchestrator-120-contracts.md):
//   * 18789..18793 are RESERVED for the four infra profiles (seeded in the
//     migration; allocator never touches them).
//   * 18794..18799 (six slots) are user-facing. allocateUserPort returns the
//     lowest free port; createProfile rejects when the range is exhausted.
//
// Slug rule:
//   * `^[a-z][a-z0-9-]{1,30}$` — kebab-case, 2..31 chars.
//   * Reserved set rejects 'main' / 'workers' / 'heavy' / 'codex-builder'
//     (the seeded infra rows; user must rename to override) plus operational
//     hot-words ('init', 'system', 'admin', 'root', 'default') so a future
//     surface that takes a slug as a path segment cannot collide.
//
// Reserved-profile guard:
//   * is_reserved=1 rows cannot be archived. The DB schema does not enforce
//     this (a stray UPDATE could still flip archived_at); the contract is
//     "all writes go through archiveProfile / setProfileStatus".
//
// Default-binding guard:
//   * Binding ids starting with 'binding-default-' are the per-kind defaults
//     seeded by the migration. unbindChannel refuses to delete them so the
//     fallback table never has a hole. The principal CAN rebind the default
//     (via bindChannel with channel_identity=null and the same kind), which
//     UPSERTs the existing row rather than inserting a new one.
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "./ulid.js";

export const PORT_RANGE_USER_LO = 18794;
export const PORT_RANGE_USER_HI = 18799;

// HERMES_HOME inside the runtime container is `/hermes-state`. ctrl-api has
// the hermes_data volume bind-mounted at this path (see docker-compose.yaml
// ctrl-api service). Channel routes use it both as the path they read the
// per-profile .env from (via fs) and as the path they prefix in `docker exec
// hermes …` commands (the same path is valid in both containers).
//
// `HERMES_CONFIG_DIR` is an override for tests so resolveProfileContextForChannel
// can be exercised without touching the real /hermes-state.
export const HERMES_PROFILE_BASE_DIR = (): string =>
  process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "main",
  "workers",
  "heavy",
  "codex-builder",
  "init",
  "system",
  "admin",
  "root",
  "default",
]);

export const KNOWN_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  "telegram",
  "slack",
  "sms",
  "email",
  "paperclip",
  "terminal",
  "voice",
  "ha",
  "omi",
  "recall",
  "tailscale",
]);

export type ProfileStatus = "pending" | "running" | "stopped" | "archived";
export type DeploymentShape = "supervised" | "sibling";

export interface AgentProfile {
  slug: string;
  label: string;
  description: string | null;
  model: string;
  deployment_shape: DeploymentShape;
  api_server_port: number;
  persona_template: string | null;
  status: ProfileStatus;
  is_user_facing: boolean;
  is_reserved: boolean;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface ChannelProfileBinding {
  id: string;
  channel_kind: string;
  channel_identity: string | null;
  profile_slug: string;
  created_at: number;
}

export interface CreateProfileInput {
  slug: string;
  label: string;
  description?: string | null;
  model: string;
  persona_template?: string | null;
  deployment_shape?: DeploymentShape;
}

const _SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

interface ProfileRow {
  slug: string;
  label: string;
  description: string | null;
  model: string;
  deployment_shape: string;
  api_server_port: number;
  persona_template: string | null;
  status: string;
  is_user_facing: number;
  is_reserved: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface BindingRow {
  id: string;
  channel_kind: string;
  channel_identity: string | null;
  profile_slug: string;
  created_at: number;
}

function _row2profile(r: ProfileRow): AgentProfile {
  return {
    slug: r.slug,
    label: r.label,
    description: r.description,
    model: r.model,
    deployment_shape: r.deployment_shape as DeploymentShape,
    api_server_port: r.api_server_port,
    persona_template: r.persona_template,
    status: r.status as ProfileStatus,
    is_user_facing: r.is_user_facing === 1,
    is_reserved: r.is_reserved === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    archived_at: r.archived_at,
  };
}

function _row2binding(r: BindingRow): ChannelProfileBinding {
  return {
    id: r.id,
    channel_kind: r.channel_kind,
    channel_identity: r.channel_identity,
    profile_slug: r.profile_slug,
    created_at: r.created_at,
  };
}

export function validateSlug(slug: unknown): string {
  if (typeof slug !== "string") {
    throw new Error("slug must be a string");
  }
  if (!_SLUG_RE.test(slug)) {
    throw new Error(
      `slug must match ${_SLUG_RE.source} (lowercase alnum + hyphens; 2..31 chars; must start with a letter)`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`slug '${slug}' is reserved`);
  }
  return slug;
}

// Supervisor registry shape — written to /hermes-state/profiles/_registry.json.
//
// The Hermes supervisor reads this file on boot (and on every SIGUSR1) to
// decide which gateway processes to keep alive. Ports + slugs are the
// load-bearing fields; everything else is informational. We intentionally
// emit a single `profiles` array (not a map keyed by slug) so the
// supervisor can iterate deterministically.
export interface SupervisorRegistryEntry {
  slug: string;
  api_server_port: number;
  model: string;
  status: ProfileStatus;
  is_reserved: boolean;
  is_user_facing: boolean;
}
export interface SupervisorRegistry {
  profiles: SupervisorRegistryEntry[];
  generated_at: number;
}

// Build the registry payload the supervisor reads. Excludes archived rows —
// an archived profile has no live gateway and would only cause a doomed
// launch attempt in the supervisor's start_proc loop.
export function buildSupervisorRegistry(db: DatabaseSync): SupervisorRegistry {
  const all = listAllProfiles(db);
  const profiles: SupervisorRegistryEntry[] = all
    .filter((p) => p.archived_at == null && p.status !== "archived")
    .map((p) => ({
      slug: p.slug,
      api_server_port: p.api_server_port,
      model: p.model,
      status: p.status,
      is_reserved: p.is_reserved,
      is_user_facing: p.is_user_facing,
    }));
  return { profiles, generated_at: Date.now() };
}

export function listAllProfiles(db: DatabaseSync): AgentProfile[] {
  const rows = db
    .prepare(
      `SELECT slug, label, description, model, deployment_shape,
              api_server_port, persona_template, status,
              is_user_facing, is_reserved,
              created_at, updated_at, archived_at
       FROM agent_profile
       ORDER BY is_reserved DESC, api_server_port ASC`,
    )
    .all() as ProfileRow[];
  return rows.map(_row2profile);
}

export function listUserProfiles(db: DatabaseSync): AgentProfile[] {
  const rows = db
    .prepare(
      `SELECT slug, label, description, model, deployment_shape,
              api_server_port, persona_template, status,
              is_user_facing, is_reserved,
              created_at, updated_at, archived_at
       FROM agent_profile
       WHERE is_user_facing = 1 AND archived_at IS NULL
       ORDER BY is_reserved DESC, api_server_port ASC`,
    )
    .all() as ProfileRow[];
  return rows.map(_row2profile);
}

export function getProfile(db: DatabaseSync, slug: string): AgentProfile | null {
  const row = db
    .prepare(
      `SELECT slug, label, description, model, deployment_shape,
              api_server_port, persona_template, status,
              is_user_facing, is_reserved,
              created_at, updated_at, archived_at
       FROM agent_profile
       WHERE slug = ?`,
    )
    .get(slug) as ProfileRow | undefined;
  return row ? _row2profile(row) : null;
}

// Lowest unused port in 18794..18799 among rows where archived_at IS NULL.
// Returns null when the range is exhausted.
export function allocateUserPort(db: DatabaseSync): number | null {
  const used = new Set<number>(
    (db
      .prepare(
        `SELECT api_server_port FROM agent_profile
         WHERE archived_at IS NULL
           AND api_server_port BETWEEN ? AND ?`,
      )
      .all(PORT_RANGE_USER_LO, PORT_RANGE_USER_HI) as { api_server_port: number }[]).map(
      (r) => r.api_server_port,
    ),
  );
  for (let p = PORT_RANGE_USER_LO; p <= PORT_RANGE_USER_HI; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

export function createProfile(db: DatabaseSync, input: CreateProfileInput): AgentProfile {
  // Slug + reserved-set check.
  const slug = validateSlug(input.slug);

  if (typeof input.label !== "string" || !input.label.trim()) {
    throw new Error("label (non-empty string) is required");
  }
  if (typeof input.model !== "string" || !input.model.trim()) {
    throw new Error("model (non-empty string) is required");
  }
  const shape: DeploymentShape = input.deployment_shape ?? "supervised";
  if (shape !== "supervised") {
    // v1 only writes 'supervised'. Sibling-container profiles are registered
    // out-of-band in Lane VI (Joe's pre-existing cratchit) and the registry
    // row is inserted there directly, not via this API.
    throw new Error(
      `deployment_shape '${shape}' not supported in v1 (sibling-container profiles must be registered via Lane VI's tooling)`,
    );
  }

  // Duplicate slug — explicit check beats catching the SQLite UNIQUE error
  // because we want the message to be route-classifiable as a 409.
  const existing = db
    .prepare("SELECT slug FROM agent_profile WHERE slug = ?")
    .get(slug);
  if (existing) {
    throw new Error(`slug '${slug}' already exists`);
  }

  const port = allocateUserPort(db);
  if (port == null) {
    throw new Error(
      `no free user-facing port (range ${PORT_RANGE_USER_LO}..${PORT_RANGE_USER_HI} exhausted; max 6 user profiles per tenant)`,
    );
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_profile
       (slug, label, description, model, deployment_shape,
        api_server_port, persona_template, status,
        is_user_facing, is_reserved,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, ?)`,
  ).run(
    slug,
    input.label.trim(),
    input.description?.trim() || null,
    input.model.trim(),
    shape,
    port,
    input.persona_template ?? null,
    now,
    now,
  );

  const created = getProfile(db, slug);
  if (!created) {
    // The INSERT above just succeeded; this branch is "should never happen".
    throw new Error(`profile '${slug}' not found after insert`);
  }
  return created;
}

export function archiveProfile(db: DatabaseSync, slug: string): AgentProfile {
  const p = getProfile(db, slug);
  if (!p) throw new Error(`profile '${slug}' not found`);
  if (p.is_reserved) {
    throw new Error(`profile '${slug}' is reserved and cannot be archived`);
  }
  if (p.archived_at != null) {
    // Idempotent — already archived.
    return p;
  }
  const now = Date.now();
  // Cascade-unbind every non-default channel binding pointing at this profile.
  //
  // Lane II observation (#120): when a profile is archived, its custom
  // channel_profile_binding rows still resolve to the archived slug. The
  // default `(channel_kind, NULL, 'main')` bindings (id prefix
  // 'binding-default-') are protected by unbindChannel's guard so the
  // per-kind fallback never has a hole. Any OTHER binding that pointed at
  // this slug is now stale and gets removed so resolveProfileForChannel
  // falls back to the default 'main' immediately. We do not retarget to
  // 'main' explicitly — deleting the row achieves the same end state via
  // the existing precedence chain (Contract 5 in agentProfiles.ts).
  db.prepare(
    `DELETE FROM channel_profile_binding
     WHERE profile_slug = ?
       AND id NOT LIKE 'binding-default-%'`,
  ).run(slug);
  db.prepare(
    `UPDATE agent_profile
       SET status = 'archived', archived_at = ?, updated_at = ?
     WHERE slug = ?`,
  ).run(now, now, slug);
  const after = getProfile(db, slug);
  if (!after) throw new Error(`profile '${slug}' not found after archive`);
  return after;
}

// Restore an archived profile so the principal can bring it back without
// re-typing the wizard. Lane III — closes the namespace UX bug Lane IIb
// flagged where an archived slug stayed reserved. Rules:
//   * Profile must exist (404 via "not found").
//   * Profile must currently be archived (otherwise it's a no-op error so
//     the UI can distinguish "already live" from "restored").
//   * Reserved profiles can't be archived in the first place; the guard
//     here is defensive in case a stray write flipped archived_at on a
//     reserved row.
//   * On restore: clear archived_at, set status='pending'. The supervisor
//     nudge (in the route layer) re-renders the profile dir and relaunches
//     the gateway just like the original create flow.
//   * Cascade-restore of channel bindings is NOT attempted — archive
//     deleted the non-default rows, so the principal re-binds via the UI
//     if they want the channel back. The per-kind 'binding-default-*'
//     rows still point at 'main', which is the safe default.
export function restoreProfile(db: DatabaseSync, slug: string): AgentProfile {
  const p = getProfile(db, slug);
  if (!p) throw new Error(`profile '${slug}' not found`);
  if (p.is_reserved) {
    // Reserved rows are never archived in normal operation; reject so the
    // route surfaces 409 rather than silently no-op'ing.
    throw new Error(`profile '${slug}' is reserved and cannot be restored`);
  }
  if (p.archived_at == null) {
    throw new Error(`profile '${slug}' is not archived`);
  }
  const now = Date.now();
  db.prepare(
    `UPDATE agent_profile
       SET status = 'pending', archived_at = NULL, updated_at = ?
     WHERE slug = ?`,
  ).run(now, slug);
  const after = getProfile(db, slug);
  if (!after) throw new Error(`profile '${slug}' not found after restore`);
  return after;
}

export function setProfileStatus(
  db: DatabaseSync,
  slug: string,
  status: ProfileStatus,
): AgentProfile {
  const p = getProfile(db, slug);
  if (!p) throw new Error(`profile '${slug}' not found`);
  if (status === "archived") {
    // Channel through archiveProfile so archived_at gets stamped too.
    return archiveProfile(db, slug);
  }
  const now = Date.now();
  db.prepare(
    `UPDATE agent_profile
       SET status = ?, updated_at = ?
     WHERE slug = ?`,
  ).run(status, now, slug);
  const after = getProfile(db, slug);
  if (!after) throw new Error(`profile '${slug}' not found after status flip`);
  return after;
}

export function listBindingsForProfile(
  db: DatabaseSync,
  slug: string,
): ChannelProfileBinding[] {
  const rows = db
    .prepare(
      `SELECT id, channel_kind, channel_identity, profile_slug, created_at
       FROM channel_profile_binding
       WHERE profile_slug = ?
       ORDER BY channel_kind, channel_identity NULLS FIRST`,
    )
    .all(slug) as BindingRow[];
  return rows.map(_row2binding);
}

export function listAllBindings(db: DatabaseSync): ChannelProfileBinding[] {
  const rows = db
    .prepare(
      `SELECT id, channel_kind, channel_identity, profile_slug, created_at
       FROM channel_profile_binding
       ORDER BY channel_kind, channel_identity NULLS FIRST`,
    )
    .all() as BindingRow[];
  return rows.map(_row2binding);
}

// Resolve precedence (the runtime read every Lane IV route will use):
//   1. exact match on (channel_kind, channel_identity) — operator-set binding.
//   2. default (channel_kind, NULL) — the per-kind fallback seeded by the
//      migration; can be rebound but never deleted.
//   3. 'main' — hard fallback. The migration seeds a default for every
//      KNOWN_CHANNEL_KIND, so this branch is only hit for unknown kinds.
export function resolveProfileForChannel(
  db: DatabaseSync,
  channel_kind: string,
  channel_identity: string | null,
): string {
  if (channel_identity != null) {
    const exact = db
      .prepare(
        `SELECT profile_slug FROM channel_profile_binding
         WHERE channel_kind = ? AND channel_identity = ?`,
      )
      .get(channel_kind, channel_identity) as { profile_slug: string } | undefined;
    if (exact) return exact.profile_slug;
  }
  const def = db
    .prepare(
      `SELECT profile_slug FROM channel_profile_binding
       WHERE channel_kind = ? AND channel_identity IS NULL`,
    )
    .get(channel_kind) as { profile_slug: string } | undefined;
  if (def) return def.profile_slug;
  return "main";
}

export function bindChannel(
  db: DatabaseSync,
  args: {
    channel_kind: string;
    channel_identity: string | null;
    profile_slug: string;
  },
): ChannelProfileBinding {
  if (typeof args.channel_kind !== "string" || !args.channel_kind.trim()) {
    throw new Error("channel_kind (non-empty string) is required");
  }
  if (!KNOWN_CHANNEL_KINDS.has(args.channel_kind)) {
    throw new Error(
      `channel_kind '${args.channel_kind}' is not a known channel (allowed: ${[...KNOWN_CHANNEL_KINDS].join(", ")})`,
    );
  }
  if (typeof args.profile_slug !== "string" || !args.profile_slug.trim()) {
    throw new Error("profile_slug (non-empty string) is required");
  }
  const target = getProfile(db, args.profile_slug);
  if (!target) {
    throw new Error(`profile '${args.profile_slug}' not found`);
  }
  if (target.archived_at != null) {
    throw new Error(
      `profile '${args.profile_slug}' is archived and cannot accept new bindings`,
    );
  }

  const identity = args.channel_identity?.trim() || null;
  const now = Date.now();

  // UPSERT on (channel_kind, channel_identity). NULL is "default" so the
  // ON CONFLICT clause hits the (kind, NULL) unique index just like a real
  // identity would. We reuse the existing id (including the
  // 'binding-default-*' ids the migration seeded) so the unbind guard
  // keeps working after a rebind.
  const existing = db
    .prepare(
      `SELECT id FROM channel_profile_binding
       WHERE channel_kind = ? AND ((? IS NULL AND channel_identity IS NULL) OR channel_identity = ?)`,
    )
    .get(args.channel_kind, identity, identity) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE channel_profile_binding
         SET profile_slug = ?
       WHERE id = ?`,
    ).run(args.profile_slug, existing.id);
    const row = db
      .prepare(
        `SELECT id, channel_kind, channel_identity, profile_slug, created_at
         FROM channel_profile_binding
         WHERE id = ?`,
      )
      .get(existing.id) as BindingRow;
    return _row2binding(row);
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO channel_profile_binding
       (id, channel_kind, channel_identity, profile_slug, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, args.channel_kind, identity, args.profile_slug, now);

  const row = db
    .prepare(
      `SELECT id, channel_kind, channel_identity, profile_slug, created_at
       FROM channel_profile_binding
       WHERE id = ?`,
    )
    .get(id) as BindingRow;
  return _row2binding(row);
}

// ── Lane IV: channel-route context resolver ───────────────────────────────
//
// The full lookup chain every channel route needs. Single round-trip with
// the registry — slug → profile row + port + api_server_key from disk.
//
// Archived-target cascade:
//   * resolveProfileForChannel can return a slug that points at an archived
//     profile (Lane III could archive a profile that still has explicit
//     bindings; Lane II's cleanup may not have rebinded them yet). When the
//     resolved profile is archived, we cascade to `main` so the channel
//     stays alive rather than 404ing on dispatch.
//   * If `main` itself is archived (shouldn't happen — it's reserved), we
//     surface the original archived profile with `archived=true` and let
//     the caller decide whether to 503.
//
// The api_server_key read can fail in legitimate ways: the profile dir
// doesn't exist yet (Lane II hasn't activated the profile), or the .env is
// missing API_SERVER_KEY (first-boot before render_hermes seeded it). Both
// cases return `api_server_key=null`; the caller decides how to respond
// (typically: 503 "profile not yet activated").

export interface ProfileChannelContext {
  /** Final resolved profile slug (after archived-target cascade). */
  slug: string;
  /** The profile slug the binding pointed at BEFORE the archived cascade.
   *  Equal to `slug` on the happy path. Useful for diagnostics. */
  bound_slug: string;
  /** True iff `bound_slug !== slug` (we cascaded). */
  cascaded: boolean;
  /** Hermes /v1 port for the resolved profile. */
  api_server_port: number;
  /** API_SERVER_KEY read from <profile_dir>/.env; null if unreadable
   *  (the profile dir doesn't exist yet, or .env lacks the key). */
  api_server_key: string | null;
  /** Absolute path of the profile dir (e.g. /hermes-state/profiles/sentinel).
   *  Used by channel routes that read/write gateway_state.json,
   *  channel_directory.json, and the per-profile .env. */
  profile_dir: string;
  /** alfred_journal.hermes_profile scoping key. Same as `slug` today; broken
   *  out so future schemes (e.g. principal-scoped) can change one place. */
  journal_scope_key: string;
}

/**
 * Read `API_SERVER_KEY` from a per-profile .env. Extracted from the
 * duplicated readers in agents.ts / hermes.ts / channels_paperclip.ts /
 * channels_ha.ts so Lane IV's channel routes resolve through one path.
 */
export function readHermesProfileApiKey(profileDir: string): string | null {
  const envPath = `${profileDir}/.env`;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === "API_SERVER_KEY") {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

export function resolveProfileContextForChannel(
  db: DatabaseSync,
  channel_kind: string,
  channel_identity: string | null,
): ProfileChannelContext {
  const boundSlug = resolveProfileForChannel(db, channel_kind, channel_identity);
  const bound = getProfile(db, boundSlug);

  // If the bound profile is archived, cascade to 'main' so the channel
  // remains live. Lane III's UI is expected to rebind before archiving in
  // the normal case; this cascade is a backstop, not the happy path.
  let slug = boundSlug;
  let row = bound;
  let cascaded = false;
  if (bound && bound.archived_at != null) {
    cascaded = true;
    slug = "main";
    row = getProfile(db, "main");
  }
  // If the bound slug doesn't exist at all (stale binding pointing at a
  // hard-deleted profile — shouldn't be possible because archive doesn't
  // delete, but be defensive), also fall back to main.
  if (!row) {
    cascaded = boundSlug !== "main";
    slug = "main";
    row = getProfile(db, "main");
  }

  // If 'main' itself is missing (the migration would have failed; this is
  // really "should never happen"), surface a synthetic 18789-on-main shape
  // so the caller can fail honestly downstream rather than crashing here.
  const port = row?.api_server_port ?? 18789;
  const baseDir = HERMES_PROFILE_BASE_DIR();
  const profileDir = `${baseDir}/${slug}`;
  const apiKey = readHermesProfileApiKey(profileDir);

  return {
    slug,
    bound_slug: boundSlug,
    cascaded,
    api_server_port: port,
    api_server_key: apiKey,
    profile_dir: profileDir,
    journal_scope_key: slug,
  };
}

// #120 Lane V — channel-route helpers.
//
// `resolveProfileEnvPath(slug)` returns the per-profile .env path that channel
// routes write to. ALWAYS goes through HERMES_PROFILE_BASE_DIR() so the env
// override (HERMES_CONFIG_DIR) tests use applies here too.
//
// `assertWritableProfile(db, slug)` validates that a channel-route write is
// allowed to target this profile:
//   * the profile must exist
//   * the profile must NOT be archived
//   * the profile must be user-facing OR exactly 'main'
//     (the reserved 'workers' / 'heavy' / 'codex-builder' rows are infra and
//      have NO channels — a token write to them is a misconfigure, not a
//      legitimate operation. Throw rather than silently writing into a dir
//      no gateway reads.)
//
// Throws on any failure; the HTTP layer catches and translates to 400/404.
export function resolveProfileEnvPath(slug: string): string {
  return `${HERMES_PROFILE_BASE_DIR()}/${slug}/.env`;
}

export function assertWritableProfile(
  db: DatabaseSync,
  slug: string,
): AgentProfile {
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error("profile slug is required");
  }
  const row = getProfile(db, slug);
  if (!row) {
    throw new Error(`profile '${slug}' not found`);
  }
  if (row.archived_at != null || row.status === "archived") {
    throw new Error(
      `profile '${slug}' is archived — restore it before changing channel tokens`,
    );
  }
  // main is always writable (even though it isn't user-facing in the wizard
  // sense). Other reserved rows (workers/heavy/codex-builder) have no
  // channels — refuse the write.
  if (!row.is_user_facing && slug !== "main") {
    throw new Error(
      `profile '${slug}' is an infrastructure profile and cannot host channels`,
    );
  }
  return row;
}

export function unbindChannel(db: DatabaseSync, id: string): void {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("binding id (non-empty string) is required");
  }
  if (id.startsWith("binding-default-")) {
    // The per-kind defaults must always exist so resolveProfileForChannel
    // never falls off the end. Rebind them via bindChannel instead.
    throw new Error(
      `binding '${id}' is a default and cannot be unbound (rebind it via POST /:slug/bindings instead)`,
    );
  }
  const row = db
    .prepare("SELECT id FROM channel_profile_binding WHERE id = ?")
    .get(id);
  if (!row) {
    throw new Error(`binding '${id}' not found`);
  }
  db.prepare("DELETE FROM channel_profile_binding WHERE id = ?").run(id);
}
