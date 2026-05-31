// profiles — multi-profile Hermes registry HTTP surface (#120 Lane I).
//
// CRUD + binding management for the agent_profile / channel_profile_binding
// tables. Registry-only — Lane II hooks the Hermes-side activation, Lane IV
// rewires channel routes to honour the bindings, Lane III adds the UI.
//
// Route map:
//   GET    /api/v1/agent-profiles
//   GET    /api/v1/agent-profiles/all
//   GET    /api/v1/agent-profiles/resolve?channel_kind=&channel_identity=
//   GET    /api/v1/agent-profiles/:slug
//   POST   /api/v1/agent-profiles                         (202)
//   DELETE /api/v1/agent-profiles/:slug
//   POST   /api/v1/agent-profiles/:slug/restore            (Lane III)
//   POST   /api/v1/agent-profiles/:slug/status             (supervisor)
//   GET    /api/v1/agent-profiles/:slug/bindings
//   POST   /api/v1/agent-profiles/:slug/bindings
//   DELETE /api/v1/agent-profiles/:slug/bindings/:binding_id
//
//   GET    /api/v1/admin/profiles/:slug/mcp                (#204 Lane I)
//   POST   /api/v1/admin/profiles/:slug/mcp                (#204 Lane I)
//   DELETE /api/v1/admin/profiles/:slug/mcp/:name          (#204 Lane I)
//
// POST returns 202 Accepted (not 201) because the Hermes-side activation is
// deferred to Lane II — the registry row writes immediately but no gateway
// is started yet. Lane II flips status from 'pending' to 'running'.
//
// DELETE archives the row (status='archived', archived_at stamped); the
// port is freed for reuse. Reserved profiles refuse archive with 409.
//
// Error classification: helper messages thrown by the lib are mapped to
// ApiError statuses by _classify(). Keeping that mapping at the route layer
// (not in the lib) means Lane II/IV callers can catch and inspect the raw
// helper errors without a `statusCode` shim.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
  ApiError,
} from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  PORT_RANGE_USER_LO,
  PORT_RANGE_USER_HI,
  KNOWN_CHANNEL_KINDS,
  RESERVED_SLUGS,
  HERMES_PROFILE_BASE_DIR,
  validateSlug,
  listAllProfiles,
  listUserProfiles,
  getProfile,
  createProfile,
  archiveProfile,
  restoreProfile,
  setProfileStatus,
  listBindingsForProfile,
  resolveProfileForChannel,
  bindChannel,
  unbindChannel,
  buildSupervisorRegistry,
} from "../../db/agentProfiles.js";
import type { AgentProfile, ProfileStatus } from "../../db/agentProfiles.js";
import { writeSupervisorRegistry, nudgeHermesSupervisor } from "../../hermes/supervisor.js";

function asObj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("JSON object body required");
  }
  return body as Record<string, unknown>;
}

function reqStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ValidationError(`${key} (non-empty string) is required`);
  }
  return v.trim();
}

function optStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Map a lib-thrown Error to the right ApiError subclass.
//
// The library throws plain Error with stable message prefixes; we match on
// those prefixes here so the surface stays:
//   400 — input shape (slug doesn't match regex, missing required field, …)
//   404 — referenced row missing
//   409 — collision / reserved / port-range exhausted / archived target
function _classify(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (!(err instanceof Error)) {
    throw err as Error;
  }
  const m = err.message;
  // 409 — collisions and reserved-state errors.
  if (m.endsWith("already exists")) throw new ConflictError(m);
  if (m.includes("is reserved")) throw new ConflictError(m);
  if (m.startsWith("no free user-facing port")) throw new ConflictError(m);
  if (m.includes("is archived")) throw new ConflictError(m);
  if (m.includes("is a default and cannot be unbound")) {
    throw new ConflictError(m);
  }
  if (m.includes("not supported in v1")) throw new ConflictError(m);
  // 400 — restore on a non-archived profile. Falls through to the generic
  // "everything else" branch below; called out so the surface contract
  // matches the UI's expectation: a Restore button click on a row that
  // somehow isn't archived shows a 400, not a confusing 409.
  // 404 — missing rows.
  if (m.startsWith("profile '") && m.endsWith("not found")) {
    throw new NotFoundError(m);
  }
  if (m.startsWith("binding '") && m.endsWith("not found")) {
    throw new NotFoundError(m);
  }
  // 400 — everything else (input shape).
  throw new ValidationError(m);
}

function _portRangeMeta(profiles: AgentProfile[]): {
  port_range: { lo: number; hi: number };
  free_slots: number;
} {
  const usedInRange = new Set<number>();
  for (const p of profiles) {
    if (p.archived_at != null) continue;
    if (
      p.api_server_port >= PORT_RANGE_USER_LO &&
      p.api_server_port <= PORT_RANGE_USER_HI
    ) {
      usedInRange.add(p.api_server_port);
    }
  }
  const total = PORT_RANGE_USER_HI - PORT_RANGE_USER_LO + 1;
  return {
    port_range: { lo: PORT_RANGE_USER_LO, hi: PORT_RANGE_USER_HI },
    free_slots: total - usedInRange.size,
  };
}

export function registerProfileRoutes(): void {
  // state.db is opened lazily on first request — see registerStateRoutes
  // for the same pattern. Route registration stays side-effect-free so
  // tests can register without a real DB.
  const db = getStateDb;

  // ─────────────────────────────────────────────────────────────
  // Profile CRUD
  // ─────────────────────────────────────────────────────────────

  // User-facing list (default — what /profiles UI shows).
  addRoute("GET", "/api/v1/agent-profiles", async ({ res }) => {
    try {
      const profiles = listUserProfiles(db());
      const meta = _portRangeMeta(listAllProfiles(db()));
      sendJson(res, 200, { profiles, ...meta });
    } catch (err) {
      _classify(err);
    }
  });

  // Admin/all list — includes hidden infra rows + archived rows.
  addRoute("GET", "/api/v1/agent-profiles/all", async ({ res }) => {
    try {
      const profiles = listAllProfiles(db());
      const meta = _portRangeMeta(profiles);
      sendJson(res, 200, { profiles, ...meta });
    } catch (err) {
      _classify(err);
    }
  });

  // Resolver — side-effect-free precedence lookup. Used by Lane IV's
  // channel routes once they migrate off hard-coded 'main'.
  addRoute("GET", "/api/v1/agent-profiles/resolve", async ({ res, query }) => {
    try {
      const channel_kind = query.get("channel_kind");
      if (!channel_kind) {
        throw new ValidationError("channel_kind (query param) is required");
      }
      const channel_identity = query.get("channel_identity");
      const slug = resolveProfileForChannel(db(), channel_kind, channel_identity);
      sendJson(res, 200, {
        channel_kind,
        channel_identity,
        profile_slug: slug,
      });
    } catch (err) {
      _classify(err);
    }
  });

  addRoute("GET", "/api/v1/agent-profiles/:slug", async ({ res, params }) => {
    try {
      const slug = params.slug;
      const profile = getProfile(db(), slug);
      if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
      const bindings = listBindingsForProfile(db(), slug);
      sendJson(res, 200, { profile, bindings });
    } catch (err) {
      _classify(err);
    }
  });

  // POST — create. Returns 202 because Hermes-side activation is Lane II.
  addRoute("POST", "/api/v1/agent-profiles", async ({ res, body }) => {
    try {
      const b = asObj(body);
      // We DO NOT call validateSlug here — createProfile does it internally,
      // and the route layer's job is just to coax the body into the right
      // shape and surface the error.
      const slug = reqStr(b, "slug");
      const label = reqStr(b, "label");
      const model = reqStr(b, "model");
      const description = optStr(b, "description");
      const persona_template = optStr(b, "persona_template");
      const shape_raw = optStr(b, "deployment_shape");
      const deployment_shape =
        shape_raw === "supervised" || shape_raw === "sibling"
          ? shape_raw
          : undefined;

      // Surface "invalid slug shape" as 400 even before we hit the lib
      // — gives a clean message and is exactly what the smoke contract
      // says ("CREATE with bad slug → 400, NOT 500").
      try {
        validateSlug(slug);
      } catch (err) {
        // validateSlug throws "slug ... is reserved" → 409 via _classify,
        // and shape errors → 400 via _classify. Let it propagate.
        _classify(err);
      }

      const profile = createProfile(db(), {
        slug,
        label,
        model,
        description,
        persona_template,
        deployment_shape,
      });
      // Lane II — write the supervisor registry + nudge Hermes so the new
      // profile dir is rendered and a gateway is launched on the allocated
      // port. Best-effort: if the registry write or the docker kill fails
      // (e.g. test harness, hermes not running yet), the registry row is
      // still durable and the next init/supervisor cycle will reconcile.
      try {
        const reg = buildSupervisorRegistry(db());
        writeSupervisorRegistry(reg);
        nudgeHermesSupervisor();
      } catch (err) {
        // Surface a warning, never block the registry write.
        console.warn(
          `[profiles] supervisor nudge after create('${slug}') failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      sendJson(res, 202, {
        profile,
        note:
          "Registry row written (status='pending'). Supervisor nudged; gateway should respond on the allocated port within ~30s.",
      });
    } catch (err) {
      _classify(err);
    }
  });

  // DELETE — archive. Idempotent on already-archived; refuses reserved.
  // Cascades unbind for any non-default binding pointing at this profile
  // (see agentProfiles.archiveProfile). Default bindings stay so the per-kind
  // fallback never has a hole.
  addRoute("DELETE", "/api/v1/agent-profiles/:slug", async ({ res, params }) => {
    try {
      const profile = archiveProfile(db(), params.slug);
      // Lane II — rewrite the supervisor registry without this profile and
      // nudge Hermes to terminate the gateway. Best-effort like create.
      try {
        const reg = buildSupervisorRegistry(db());
        writeSupervisorRegistry(reg);
        nudgeHermesSupervisor();
      } catch (err) {
        console.warn(
          `[profiles] supervisor nudge after archive('${params.slug}') failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      sendJson(res, 200, {
        profile,
        note:
          "Registry row archived. Cascade-unbound non-default channel bindings. Supervisor nudged to stop the gateway.",
      });
    } catch (err) {
      _classify(err);
    }
  });

  // POST :slug/restore — bring an archived profile back. Lane III closes
  // the namespace UX bug: an archived slug stayed reserved and the only
  // way back was re-typing the wizard with a fresh slug. The lib's
  // restoreProfile clears archived_at + sets status='pending'; the
  // supervisor nudge below re-renders the profile dir and relaunches the
  // gateway on the original port (same allocator rule applies — the port
  // was freed at archive, restore re-uses whatever port allocateUserPort
  // would have picked … but in practice the row still has the previous
  // api_server_port set so the relaunch lands on the same port). Reserved
  // profiles can't be archived in the first place, so the lib rejects a
  // restore call on them as a 409.
  //
  // 400 path: profile is already live → "profile 'X' is not archived".
  // 404 path: profile doesn't exist → "profile 'X' not found".
  // 409 path: profile is reserved (defensive — shouldn't happen).
  addRoute(
    "POST",
    "/api/v1/agent-profiles/:slug/restore",
    async ({ res, params }) => {
      try {
        const profile = restoreProfile(db(), params.slug);
        // Same best-effort supervisor pattern as create — write the
        // registry first so a successful HTTP response means the row is
        // durable, then nudge Hermes to re-render the profile dir.
        try {
          const reg = buildSupervisorRegistry(db());
          writeSupervisorRegistry(reg);
          nudgeHermesSupervisor();
        } catch (err) {
          console.warn(
            `[profiles] supervisor nudge after restore('${params.slug}') failed:`,
            err instanceof Error ? err.message : err,
          );
        }
        sendJson(res, 200, {
          profile,
          note:
            "Registry row restored (status='pending'). Supervisor nudged; gateway should respond on the allocated port within ~30s.",
        });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // POST :slug/status — supervisor callback. The Hermes supervisor calls
  // this after each gateway start/stop to flip the registry row's status
  // ('pending' → 'running' on /health success; 'running' → 'stopped' on a
  // clean stop). Same auth as the rest of /api/v1/agent-profiles/*.
  //
  // Status transitions are NOT validated against the current value — the
  // supervisor is the authority for whether a process is live, and a stale
  // ctrl-api write would otherwise pin a stuck status. Archived status is
  // routed through archiveProfile via the lib so archived_at gets stamped;
  // it's an error to flip an already-archived profile to a live status.
  addRoute(
    "POST",
    "/api/v1/agent-profiles/:slug/status",
    async ({ res, params, body }) => {
      try {
        const b = asObj(body);
        const status = reqStr(b, "status");
        if (
          status !== "pending" &&
          status !== "running" &&
          status !== "stopped" &&
          status !== "archived"
        ) {
          throw new ValidationError(
            "status must be one of: pending | running | stopped | archived",
          );
        }
        const profile = setProfileStatus(
          db(),
          params.slug,
          status as ProfileStatus,
        );
        sendJson(res, 200, { profile });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // Channel bindings
  // ─────────────────────────────────────────────────────────────

  addRoute(
    "GET",
    "/api/v1/agent-profiles/:slug/bindings",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        const bindings = listBindingsForProfile(db(), slug);
        sendJson(res, 200, { profile_slug: slug, bindings });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // POST :slug/bindings — bind (or rebind) (channel_kind, channel_identity)
  // to this profile. UPSERT semantics — if the channel is already bound,
  // the existing row is updated rather than duplicated. The
  // 'binding-default-<kind>' rows are seeded with channel_identity=NULL;
  // POST with no channel_identity overwrites the default cleanly.
  addRoute(
    "POST",
    "/api/v1/agent-profiles/:slug/bindings",
    async ({ res, params, body }) => {
      try {
        const slug = params.slug;
        const b = asObj(body);
        const channel_kind = reqStr(b, "channel_kind");
        const channel_identity = optStr(b, "channel_identity");
        if (!KNOWN_CHANNEL_KINDS.has(channel_kind)) {
          throw new ValidationError(
            `channel_kind '${channel_kind}' is not known (allowed: ${[...KNOWN_CHANNEL_KINDS].join(", ")})`,
          );
        }
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        const binding = bindChannel(db(), {
          channel_kind,
          channel_identity,
          profile_slug: slug,
        });
        sendJson(res, 200, { binding });
      } catch (err) {
        _classify(err);
      }
    },
  );

  addRoute(
    "DELETE",
    "/api/v1/agent-profiles/:slug/bindings/:binding_id",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        unbindChannel(db(), params.binding_id);
        sendJson(res, 200, { ok: true, binding_id: params.binding_id });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────
  // Per-profile MCP catalog (#204 Lane I — C1 contract)
  //
  // Source of truth: each profile's config.yaml `mcp_servers` block
  // (same volume the hermes runtime reads). We read/write directly via
  // the filesystem rather than the CLI because `hermes mcp` has no
  // `-p <slug>` flag and `hermes mcp add` is interactive (prompts).
  //
  // Reserved profiles: GET is read-only and works on all slugs.
  //                    POST and DELETE refuse reserved slugs → 409.
  // ─────────────────────────────────────────────────────────────

  /** Resolved path to a profile's config.yaml (via the ctrl-api volume view). */
  function profileConfigPath(slug: string): string {
    return path.join(HERMES_PROFILE_BASE_DIR(), slug, "config.yaml");
  }

  /** Load + parse a profile config.yaml. Returns {} if unreadable. */
  function loadProfileConfig(slug: string): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(profileConfigPath(slug), "utf-8");
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* unreadable / unparseable — caller handles {} */
    }
    return {};
  }

  /**
   * Derive the canonical wire shape for one mcp_servers entry.
   * The config.yaml block can be null (disabled), or an object with
   * optional `command`/`args`/`url`/`enabled` fields — we normalise to
   * the C1 contract shape.
   */
  function _mcpServerShape(
    name: string,
    block: unknown,
  ): { name: string; type: "stdio" | "http"; command_or_url: string; enabled: boolean } {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      // null / disabled block — show as stdio placeholder
      return { name, type: "stdio", command_or_url: "", enabled: false };
    }
    const b = block as Record<string, unknown>;
    const hasUrl = typeof b["url"] === "string" && (b["url"] as string).trim();
    const type: "stdio" | "http" = hasUrl ? "http" : "stdio";
    let command_or_url = "";
    if (hasUrl) {
      command_or_url = (b["url"] as string).trim();
    } else if (typeof b["command"] === "string") {
      const args =
        Array.isArray(b["args"])
          ? (b["args"] as string[]).join(" ")
          : "";
      command_or_url = args
        ? `${(b["command"] as string).trim()} ${args}`.trimEnd()
        : (b["command"] as string).trim();
    }
    // `enabled` is true by default; null block or explicit `enabled: false` disables.
    const enabled = b["enabled"] !== false;
    return { name, type, command_or_url, enabled };
  }

  /** MCP server name must be a safe identifier (no shell injection). */
  const MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/;

  // GET /api/v1/admin/profiles/:slug/mcp
  addRoute(
    "GET",
    "/api/v1/admin/profiles/:slug/mcp",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);

        const cfg = loadProfileConfig(slug);
        const rawServers = (cfg["mcp_servers"] ?? {}) as Record<string, unknown>;
        const servers = Object.entries(rawServers).map(([name, block]) =>
          _mcpServerShape(name, block),
        );

        sendJson(res, 200, {
          slug,
          reserved: RESERVED_SLUGS.has(slug),
          servers,
        });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // POST /api/v1/admin/profiles/:slug/mcp
  addRoute(
    "POST",
    "/api/v1/admin/profiles/:slug/mcp",
    async ({ res, params, body }) => {
      try {
        const slug = params.slug;
        if (RESERVED_SLUGS.has(slug)) {
          throw new ConflictError("reserved_profile");
        }
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);

        const b = asObj(body);
        const name = reqStr(b, "name");
        if (!MCP_NAME_RE.test(name)) {
          throw new ValidationError(
            "name must match ^[a-z][a-z0-9_-]{0,40}$ (lowercase, start with letter)",
          );
        }
        const url = optStr(b, "url");
        const command = optStr(b, "command");
        if (url && command) {
          throw new ValidationError("provide url OR command, not both");
        }
        if (!url && !command) {
          throw new ValidationError("one of url or command is required");
        }
        const auth_header = optStr(b, "auth_header");
        const auth_value = optStr(b, "auth_value");

        // Load existing config and add / replace the server entry.
        const cfgPath = profileConfigPath(slug);
        let cfg: Record<string, unknown> = {};
        let rawYaml = "";
        try {
          rawYaml = fs.readFileSync(cfgPath, "utf-8");
          const parsed = yaml.load(rawYaml);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            cfg = parsed as Record<string, unknown>;
          }
        } catch {
          /* config doesn't exist yet — start fresh */
        }

        // Build the new server block.
        const newBlock: Record<string, unknown> = {};
        if (url) {
          newBlock["url"] = url;
          if (auth_header && auth_value) {
            newBlock["auth"] = {
              type: "header",
              header: auth_header,
              value: auth_value,
            };
          }
        } else {
          // stdio: split command string on spaces for args
          const parts = (command as string).trim().split(/\s+/);
          newBlock["command"] = parts[0];
          if (parts.length > 1) {
            newBlock["args"] = parts.slice(1);
          }
        }

        if (!cfg["mcp_servers"] || typeof cfg["mcp_servers"] !== "object") {
          cfg["mcp_servers"] = {};
        }
        (cfg["mcp_servers"] as Record<string, unknown>)[name] = newBlock;

        // Atomic write — yaml.dump + rename.
        const newYaml = yaml.dump(cfg, { lineWidth: 120, quotingType: '"' });
        const tmpPath = cfgPath + ".tmp";
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(tmpPath, newYaml, { encoding: "utf-8", mode: 0o644 });
        fs.renameSync(tmpPath, cfgPath);

        // Nudge the supervisor so the profile's gateway picks up the new server.
        try {
          nudgeHermesSupervisor();
        } catch (err) {
          console.warn(
            `[profiles/mcp] supervisor nudge after add('${slug}/${name}') failed:`,
            err instanceof Error ? err.message : err,
          );
        }

        sendJson(res, 201, { ok: true, name });
      } catch (err) {
        _classify(err);
      }
    },
  );

  // DELETE /api/v1/admin/profiles/:slug/mcp/:name
  addRoute(
    "DELETE",
    "/api/v1/admin/profiles/:slug/mcp/:name",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        if (RESERVED_SLUGS.has(slug)) {
          throw new ConflictError("reserved_profile");
        }
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);

        const name = params.name;
        const cfgPath = profileConfigPath(slug);
        let cfg: Record<string, unknown> = {};
        try {
          const raw = fs.readFileSync(cfgPath, "utf-8");
          const parsed = yaml.load(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            cfg = parsed as Record<string, unknown>;
          }
        } catch {
          throw new NotFoundError(`profile '${slug}' has no config (config.yaml unreadable)`);
        }

        const servers = cfg["mcp_servers"] as Record<string, unknown> | undefined;
        if (!servers || !(name in servers)) {
          throw new NotFoundError(`MCP server '${name}' not found in profile '${slug}'`);
        }
        delete servers[name];
        cfg["mcp_servers"] = servers;

        const newYaml = yaml.dump(cfg, { lineWidth: 120, quotingType: '"' });
        const tmpPath = cfgPath + ".tmp";
        fs.writeFileSync(tmpPath, newYaml, { encoding: "utf-8", mode: 0o644 });
        fs.renameSync(tmpPath, cfgPath);

        // Nudge supervisor.
        try {
          nudgeHermesSupervisor();
        } catch (err) {
          console.warn(
            `[profiles/mcp] supervisor nudge after remove('${slug}/${name}') failed:`,
            err instanceof Error ? err.message : err,
          );
        }

        sendJson(res, 200, { ok: true });
      } catch (err) {
        _classify(err);
      }
    },
  );
}
