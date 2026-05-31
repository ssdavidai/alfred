// ProfileDetailPage — single profile + its channel bindings + lifecycle.
// (#120 Lane III, #204 Lane III MCP section)
//
// Backend wire shape from ctrl-api (Lane I):
//   GET /api/v1/agent-profiles/:slug → { profile: {...}, bindings: [...] }
//   GET /api/v1/admin/profiles/:slug/mcp → { slug, reserved, servers: [...] }
//
// Sections:
//   * Header     — label · status pill · port · model · last-active
//   * Channels   — list bindings (kind + identity) + a "Bind channel" form
//   * MCP        — list registered MCP servers + add/remove (non-reserved only)
//   * Persona    — read-only persona_template (edit lives in a follow-up)
//   * Lifecycle  — Archive (user-facing non-reserved) or Restore (archived)
//
// Polling: status='pending' rows tick every 3s for 90s so the create-flow
// "Sentinel coming up… ~30s" promise lands without a manual refresh. We
// stop polling once status hits running/stopped/archived (terminal for
// our purposes).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useQuery,
  getAgentProfile,
  getProfileMcp,
  archiveAgentProfile,
  restoreAgentProfile,
  bindChannelToProfile,
  unbindChannelFromProfile,
  addProfileMcp,
  removeProfileMcp,
} from "wasp/client/operations";
import { Frame, PageHeading } from "../client/components/ab/Frame";

// Mirror of KNOWN_CHANNEL_KINDS in packages/ctrl/src/db/agentProfiles.ts
// — kept in lockstep with the server-side allowlist.
const CHANNEL_KINDS: { value: string; label: string; placeholder: string }[] = [
  { value: "telegram", label: "Telegram", placeholder: "chat_id, e.g. 123456" },
  { value: "slack", label: "Slack", placeholder: "workspace:channel, e.g. T01:C09" },
  { value: "sms", label: "SMS", placeholder: "E.164 number, e.g. +14155551212" },
  { value: "voice", label: "Voice", placeholder: "E.164 number, e.g. +14155551212" },
  { value: "email", label: "Email", placeholder: "address, e.g. alfred@…" },
  { value: "paperclip", label: "Paperclip", placeholder: "agent id, e.g. pcp_…" },
  { value: "omi", label: "Omi", placeholder: "device id" },
  { value: "ha", label: "Home Assistant", placeholder: "device id" },
  { value: "recall", label: "Recall.ai", placeholder: "meeting id" },
  { value: "terminal", label: "Terminal", placeholder: "session id" },
  { value: "tailscale", label: "Tailscale", placeholder: "node id" },
];

interface ProfileRow {
  slug: string;
  label: string;
  description: string | null;
  model: string;
  api_server_port: number;
  persona_template: string | null;
  status: "pending" | "running" | "stopped" | "archived";
  is_user_facing: boolean;
  is_reserved: boolean;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface Binding {
  id: string;
  channel_kind: string;
  channel_identity: string | null;
  profile_slug: string;
  created_at: number;
}

function StatusPill({ status }: { status: ProfileRow["status"] }) {
  const colors: Record<ProfileRow["status"], { fg: string; bg: string }> = {
    pending: { fg: "#C9A84C", bg: "rgba(201,168,76,0.12)" },
    running: { fg: "#3D7B4F", bg: "rgba(61,123,79,0.15)" },
    stopped: { fg: "#8A8680", bg: "rgba(138,134,128,0.15)" },
    archived: { fg: "#8A8680", bg: "rgba(138,134,128,0.08)" },
  };
  const c = colors[status];
  return (
    <span
      className="inline-block font-mono text-[10px] uppercase tracking-[0.18em] px-2 py-0.5"
      style={{ color: c.fg, background: c.bg }}
    >
      {status}
    </span>
  );
}

function fmtRelative(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export default function ProfileDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery(getAgentProfile, {
    slug,
  });

  const profile = (data as any)?.profile as ProfileRow | undefined;
  const bindings = ((data as any)?.bindings ?? []) as Binding[];

  const [bindKind, setBindKind] = useState(CHANNEL_KINDS[0].value);
  const [bindIdentity, setBindIdentity] = useState("");
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  // MCP section state
  const {
    data: mcpData,
    refetch: refetchMcp,
  } = useQuery(getProfileMcp, { slug }, { enabled: !!slug });

  const mcpServers = ((mcpData as any)?.servers ?? []) as Array<{
    name: string;
    type: "stdio" | "http";
    command_or_url: string;
    enabled: boolean;
  }>;
  const mcpReserved = (mcpData as any)?.reserved === true;

  // MCP add-form state
  const MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/;
  const [mcpName, setMcpName] = useState("");
  const [mcpMode, setMcpMode] = useState<"url" | "command">("url");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpAuthHeader, setMcpAuthHeader] = useState("");
  const [mcpAuthValue, setMcpAuthValue] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  // MCP remove confirm state: holds the server name to confirm removal
  const [confirmRemoveMcp, setConfirmRemoveMcp] = useState<string | null>(null);

  async function onAddMcp() {
    if (mcpBusy || !slug) return;
    const trimmedName = mcpName.trim();
    const trimmedUrl = mcpUrl.trim();
    const trimmedCommand = mcpCommand.trim();
    if (!MCP_NAME_RE.test(trimmedName)) {
      setMcpError("Name must match ^[a-z][a-z0-9_-]{0,40}$");
      return;
    }
    if (mcpMode === "url" && !trimmedUrl) {
      setMcpError("URL is required");
      return;
    }
    if (mcpMode === "command" && !trimmedCommand) {
      setMcpError("Command is required");
      return;
    }
    setMcpBusy(true);
    setMcpError(null);
    try {
      await addProfileMcp({
        slug,
        name: trimmedName,
        ...(mcpMode === "url" ? { url: trimmedUrl } : { command: trimmedCommand }),
        ...(mcpAuthHeader.trim() ? { auth_header: mcpAuthHeader.trim() } : {}),
        ...(mcpAuthValue.trim() ? { auth_value: mcpAuthValue.trim() } : {}),
      });
      setMcpName("");
      setMcpUrl("");
      setMcpCommand("");
      setMcpAuthHeader("");
      setMcpAuthValue("");
      await refetchMcp();
    } catch (e: any) {
      setMcpError(String(e?.message || e || "Couldn't add the MCP server."));
    } finally {
      setMcpBusy(false);
    }
  }

  async function onRemoveMcp(name: string) {
    if (!slug) return;
    try {
      await removeProfileMcp({ slug, name });
      setConfirmRemoveMcp(null);
      await refetchMcp();
    } catch (e: any) {
      setMcpError(String(e?.message || e || "Couldn't remove the MCP server."));
      setConfirmRemoveMcp(null);
    }
  }

  // Poll status while pending; stop once we hit a terminal-for-display
  // status. The Lane IIb smoke shows ~17s to running on a fresh tenant,
  // so 3s × 30 = 90s is plenty.
  useEffect(() => {
    if (!profile) return;
    if (profile.status !== "pending") return;
    let cancelled = false;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      if (cancelled || ticks > 30) {
        clearInterval(interval);
        return;
      }
      refetch().catch(() => {
        /* ignore — next tick will retry */
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [profile?.status, profile?.slug, refetch]);

  async function onBind() {
    if (bindBusy || !slug) return;
    setBindBusy(true);
    setBindError(null);
    try {
      await bindChannelToProfile({
        slug,
        channel_kind: bindKind,
        channel_identity: bindIdentity.trim() || undefined,
      });
      setBindIdentity("");
      await refetch();
    } catch (e: any) {
      setBindError(String(e?.message || e || "Couldn't bind the channel."));
    } finally {
      setBindBusy(false);
    }
  }

  async function onUnbind(binding_id: string) {
    if (!slug) return;
    try {
      await unbindChannelFromProfile({ slug, binding_id });
      await refetch();
    } catch (e: any) {
      setBindError(String(e?.message || e || "Couldn't unbind the channel."));
    }
  }

  async function onArchive() {
    if (!slug || lifecycleBusy) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await archiveAgentProfile({ slug });
      // After archive, route back to the list — the row is hidden by
      // default (show-archived toggle reveals it).
      navigate("/profiles");
    } catch (e: any) {
      setLifecycleError(
        String(e?.message || e || "Couldn't archive the profile."),
      );
      setLifecycleBusy(false);
    }
  }

  async function onRestore() {
    if (!slug || lifecycleBusy) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await restoreAgentProfile({ slug });
      await refetch();
    } catch (e: any) {
      setLifecycleError(
        String(e?.message || e || "Couldn't restore the profile."),
      );
    } finally {
      setLifecycleBusy(false);
    }
  }

  const groupedBindings = useMemo(() => {
    const groups: Record<string, Binding[]> = {};
    for (const b of bindings) {
      (groups[b.channel_kind] ||= []).push(b);
    }
    return groups;
  }, [bindings]);

  if (isLoading) {
    return (
      <Frame>
        <section className="mx-auto max-w-[1080px] px-8 py-12">
          <div
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            Reading {slug}…
          </div>
        </section>
      </Frame>
    );
  }

  if (error || !profile) {
    return (
      <Frame>
        <section className="mx-auto max-w-[1080px] px-8 py-12">
          <Link
            to="/profiles"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            ← Back to profiles
          </Link>
          <div className="border border-rule p-8 mt-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Couldn't read this profile
            </div>
            <p
              className="font-body italic"
              style={{ color: "var(--marginalia)" }}
            >
              {(error as any)?.message ||
                "The registry didn't return a row for this slug."}
            </p>
          </div>
        </section>
      </Frame>
    );
  }

  const isArchived = profile.status === "archived" || profile.archived_at != null;
  const canArchive = profile.is_user_facing && !profile.is_reserved && !isArchived;
  const canRestore = isArchived && !profile.is_reserved;

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="mb-2">
          <Link
            to="/profiles"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            ← Back to profiles
          </Link>
        </div>

        <PageHeading
          kicker={profile.slug}
          title={profile.label}
          lede={profile.description || undefined}
          icon="calling_card"
        />

        {/* Status strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-12 pb-6 border-b border-rule">
          <StatusPill status={profile.status} />
          <div className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
            Port :{profile.api_server_port}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
            Model · {profile.model}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
            Updated {fmtRelative(profile.updated_at)}
          </div>
          {profile.status === "pending" && (
            <div className="font-body italic" style={{ color: "var(--brass)" }}>
              Sentinel coming up… ~30s
            </div>
          )}
        </div>

        {/* Channels */}
        <section className="mb-16">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            Channels
          </div>
          <h2 className="font-display text-3xl tracking-tight mb-6">
            What this persona answers on.
          </h2>

          {bindings.length === 0 && (
            <p
              className="font-body italic mb-6"
              style={{ color: "var(--marginalia)" }}
            >
              No channels are bound to this profile yet. Sir's main butler
              picks up every channel by default; bind something here to route
              that channel to this persona instead.
            </p>
          )}

          {bindings.length > 0 && (
            <div className="border-t border-rule mb-6">
              {Object.entries(groupedBindings).map(([kind, rows]) => (
                <div
                  key={kind}
                  className="py-4 border-b border-rule grid grid-cols-[120px_1fr_auto] items-center gap-4"
                >
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em]"
                    style={{ color: "var(--brass)" }}
                  >
                    {kind}
                  </div>
                  <div className="space-y-1">
                    {rows.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center gap-3 font-mono text-[12px]"
                      >
                        <span>
                          {b.channel_identity || (
                            <em style={{ color: "var(--marginalia)" }}>
                              default (every {kind})
                            </em>
                          )}
                        </span>
                        {b.id.startsWith("binding-default-") ? (
                          <span
                            className="font-mono text-[10px] uppercase tracking-[0.18em] px-1.5"
                            style={{
                              color: "var(--marginalia)",
                              border: "1px solid var(--rule)",
                            }}
                          >
                            default
                          </span>
                        ) : (
                          <button
                            onClick={() => onUnbind(b.id)}
                            className="font-mono text-[10px] uppercase tracking-[0.18em]"
                            style={{ color: "#B85C5C" }}
                          >
                            Unbind
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div />
                </div>
              ))}
            </div>
          )}

          {!isArchived && (
            <div className="border border-rule p-5">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                style={{ color: "var(--brass)" }}
              >
                Bind a new channel
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[160px_1fr_auto] gap-3 items-center">
                <select
                  value={bindKind}
                  onChange={(e) => setBindKind(e.target.value)}
                  className="bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                  style={{ borderColor: "var(--brass)" }}
                >
                  {CHANNEL_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  value={bindIdentity}
                  onChange={(e) => setBindIdentity(e.target.value)}
                  placeholder={
                    CHANNEL_KINDS.find((k) => k.value === bindKind)
                      ?.placeholder || "identity"
                  }
                  className="bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                  style={{ borderColor: "var(--brass)" }}
                />
                <button
                  onClick={onBind}
                  disabled={bindBusy}
                  className="btn-brass"
                  style={{ opacity: bindBusy ? 0.5 : 1 }}
                >
                  {bindBusy ? "Binding…" : "Bind"}
                </button>
              </div>
              <p
                className="font-body italic text-sm mt-3"
                style={{ color: "var(--marginalia)" }}
              >
                Leave the identity blank to make this profile the default for
                every {bindKind} channel.
              </p>
              {bindError && (
                <div
                  className="mt-3 font-body italic text-sm"
                  style={{ color: "#B85C5C" }}
                >
                  {bindError}
                </div>
              )}
            </div>
          )}
        </section>

        {/* MCP servers — #204 Lane III */}
        <section className="mb-16">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            MCP servers
          </div>
          <h2 className="font-display text-3xl tracking-tight mb-6">
            Model Context Protocol servers on this profile.
          </h2>

          {profile.is_reserved && (
            <p
              className="font-body italic mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              Reserved profile — MCP servers managed by operators.
            </p>
          )}

          {mcpServers.length === 0 && !profile.is_reserved && (
            <p
              className="font-body italic mb-6"
              style={{ color: "var(--marginalia)" }}
            >
              No MCP servers registered on this profile yet.
            </p>
          )}

          {mcpServers.length > 0 && (
            <div className="border-t border-rule mb-6">
              {mcpServers.map((srv) => (
                <div
                  key={srv.name}
                  className="py-4 border-b border-rule grid grid-cols-[140px_60px_1fr_auto] items-center gap-4"
                >
                  <div
                    className="font-mono text-[12px] font-medium truncate"
                    style={{ color: "var(--ink)" }}
                  >
                    {srv.name}
                  </div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 text-center"
                    style={{
                      color: "var(--marginalia)",
                      border: "1px solid var(--rule)",
                    }}
                  >
                    {srv.type}
                  </div>
                  <div
                    className="font-mono text-[11px] truncate"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {srv.command_or_url}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.18em]"
                      style={{
                        color: srv.enabled ? "#3D7B4F" : "var(--marginalia)",
                      }}
                    >
                      {srv.enabled ? "on" : "off"}
                    </span>
                    {!profile.is_reserved && (
                      confirmRemoveMcp === srv.name ? (
                        <span className="flex items-center gap-2">
                          <button
                            onClick={() => onRemoveMcp(srv.name)}
                            className="font-mono text-[10px] uppercase tracking-[0.18em]"
                            style={{ color: "#B85C5C" }}
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmRemoveMcp(null)}
                            className="font-mono text-[10px] uppercase tracking-[0.18em]"
                            style={{ color: "var(--marginalia)" }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmRemoveMcp(srv.name)}
                          className="font-mono text-[10px] uppercase tracking-[0.18em]"
                          style={{ color: "#B85C5C" }}
                        >
                          Remove
                        </button>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!profile.is_reserved && !isArchived && (
            <div className="border border-rule p-5">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                style={{ color: "var(--brass)" }}
              >
                Add MCP server
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                  <div>
                    <label
                      className="font-mono text-[10px] uppercase tracking-[0.18em] block mb-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Name
                    </label>
                    <input
                      value={mcpName}
                      onChange={(e) => setMcpName(e.target.value)}
                      placeholder="e.g. my-tool"
                      className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                      style={{ borderColor: "var(--brass)" }}
                    />
                    <p
                      className="font-body italic text-[11px] mt-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Lowercase, start with a letter, max 41 chars.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer font-mono text-[12px]">
                    <input
                      type="radio"
                      name={`mcp-mode-${slug}`}
                      value="url"
                      checked={mcpMode === "url"}
                      onChange={() => setMcpMode("url")}
                    />
                    HTTP URL
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer font-mono text-[12px]">
                    <input
                      type="radio"
                      name={`mcp-mode-${slug}`}
                      value="command"
                      checked={mcpMode === "command"}
                      onChange={() => setMcpMode("command")}
                    />
                    stdio command
                  </label>
                </div>

                {mcpMode === "url" ? (
                  <input
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="https://…"
                    className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                    style={{ borderColor: "var(--brass)" }}
                  />
                ) : (
                  <input
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                    placeholder="node /path/to/server.js"
                    className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                    style={{ borderColor: "var(--brass)" }}
                  />
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label
                      className="font-mono text-[10px] uppercase tracking-[0.18em] block mb-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Auth header (optional)
                    </label>
                    <input
                      value={mcpAuthHeader}
                      onChange={(e) => setMcpAuthHeader(e.target.value)}
                      placeholder="Authorization"
                      className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                      style={{ borderColor: "var(--brass)" }}
                    />
                  </div>
                  <div>
                    <label
                      className="font-mono text-[10px] uppercase tracking-[0.18em] block mb-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Auth value (optional)
                    </label>
                    <input
                      value={mcpAuthValue}
                      onChange={(e) => setMcpAuthValue(e.target.value)}
                      placeholder="Bearer …"
                      className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2"
                      style={{ borderColor: "var(--brass)" }}
                    />
                  </div>
                </div>

                <button
                  onClick={onAddMcp}
                  disabled={mcpBusy}
                  className="btn-brass"
                  style={{ opacity: mcpBusy ? 0.5 : 1 }}
                >
                  {mcpBusy ? "Adding…" : "Add MCP server"}
                </button>
              </div>
              {mcpError && (
                <div
                  className="mt-3 font-body italic text-sm"
                  style={{ color: "#B85C5C" }}
                >
                  {mcpError}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Persona */}
        {profile.persona_template && (
          <section className="mb-16">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
              style={{ color: "var(--brass)" }}
            >
              Persona
            </div>
            <h2 className="font-display text-3xl tracking-tight mb-6">
              The seed of this persona's SOUL.md.
            </h2>
            <pre
              className="font-body whitespace-pre-wrap text-[14px] leading-7 p-5 border border-rule"
              style={{ color: "var(--ink)" }}
            >
              {profile.persona_template}
            </pre>
            <p
              className="font-body italic text-sm mt-3"
              style={{ color: "var(--marginalia)" }}
            >
              Editing the persona is a follow-up; for now Sir can drop a new
              SOUL.md straight into the profile's directory on the host.
            </p>
          </section>
        )}

        {/* Lifecycle */}
        <section className="mb-16">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            Lifecycle
          </div>

          {profile.is_reserved && (
            <p
              className="font-body italic"
              style={{ color: "var(--marginalia)" }}
            >
              This is a reserved infrastructure profile and cannot be archived
              or restored from this page.
            </p>
          )}

          {canArchive && !confirmArchive && (
            <button
              onClick={() => setConfirmArchive(true)}
              className="btn-ghost"
              style={{ color: "#B85C5C", borderColor: "#B85C5C" }}
            >
              Archive {profile.label}
            </button>
          )}

          {canArchive && confirmArchive && (
            <div className="border border-rule p-5">
              <p className="font-body mb-4">
                This will stop the gateway on port :{profile.api_server_port}
                . Channel bindings unique to this profile will be removed; the
                per-kind defaults stay pointed at {`main`}. Sir can bring this
                profile back later from the archive — the slug is held.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={onArchive}
                  disabled={lifecycleBusy}
                  className="btn-brass"
                  style={{
                    background: "#B85C5C",
                    opacity: lifecycleBusy ? 0.5 : 1,
                  }}
                >
                  {lifecycleBusy ? "Archiving…" : "Confirm archive"}
                </button>
                <button
                  onClick={() => setConfirmArchive(false)}
                  className="btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {canRestore && (
            <div className="border border-rule p-5">
              <p className="font-body mb-4">
                This profile is archived. Restoring brings the gateway back
                up on port :{profile.api_server_port}; Sentinel will be in a
                "pending" state for ~30 seconds.
              </p>
              <button
                onClick={onRestore}
                disabled={lifecycleBusy}
                className="btn-brass"
                style={{ opacity: lifecycleBusy ? 0.5 : 1 }}
              >
                {lifecycleBusy ? "Restoring…" : "Restore profile"}
              </button>
            </div>
          )}

          {lifecycleError && (
            <div
              className="mt-3 font-body italic text-sm"
              style={{ color: "#B85C5C" }}
            >
              {lifecycleError}
            </div>
          )}
        </section>
      </section>
    </Frame>
  );
}
