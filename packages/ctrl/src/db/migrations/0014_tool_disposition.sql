-- 0014_tool_disposition — runtime-flippable MCP-server tool disposition (Phase B).
--
-- Sir's "both tracks" architecture: every MCP server registered on the main
-- profile gets a per-server disposition flag — DIRECT (LLM calls native
-- tools) or DELEGATED (tools hidden on main, accessed via the new
-- `delegate_to_focused_agent` MCP tool that fans out to a workers-profile
-- focused subagent).
--
-- This table is the source of truth read by:
--   * `packages/hermes/init/render_mcp_servers.py` at init time to decide
--     whether each server's `tools.include` should be the full whitelist
--     (DIRECT) or an empty array `[]` (DELEGATED — tools hidden but the
--     server stays spawned so workers + heavy profiles still have access).
--   * `packages/ctrl/src/api/routes/agents.ts` for the GET/POST
--     /api/v1/agents/tool-disposition surface that powers both the
--     dashboard toggle and the `set_tool_disposition` / `list_tool_dispositions`
--     MCP tools.
--
-- Default seed: every known server lands as `direct` — initial deploy is
-- behaviour-identical to today. Sir's the one who flips servers to
-- `delegated` when he wants the token savings (and accepts the +3-5s
-- delegation hop per tool use).
--
-- The PRIMARY KEY on `server` is deliberate: there's exactly one
-- disposition per server. UPDATEs of the same server are upserts via
-- INSERT ... ON CONFLICT in the route layer; this table never grows
-- past the 9-row catalogue.

CREATE TABLE IF NOT EXISTS tool_disposition (
  server TEXT PRIMARY KEY,
  disposition TEXT NOT NULL DEFAULT 'direct',
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

INSERT OR IGNORE INTO tool_disposition (server, disposition, updated_at, updated_by) VALUES
  ('alfred-ctrl', 'direct', CURRENT_TIMESTAMP, 'init'),
  ('alfred',      'direct', CURRENT_TIMESTAMP, 'init'),
  ('sure',        'direct', CURRENT_TIMESTAMP, 'init'),
  ('plane',       'direct', CURRENT_TIMESTAMP, 'init'),
  ('vaultwarden', 'direct', CURRENT_TIMESTAMP, 'init'),
  ('execute',     'direct', CURRENT_TIMESTAMP, 'init'),
  ('paperclip',   'direct', CURRENT_TIMESTAMP, 'init'),
  ('hass',        'direct', CURRENT_TIMESTAMP, 'init'),
  ('files',       'direct', CURRENT_TIMESTAMP, 'init');
