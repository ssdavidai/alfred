// ConnectionsPage — Composio catalogue, restyled (#863).
//
// Wraps the existing integration ops (getIntegrationCatalog,
// getConnectedIntegrations, initiateConnect, initiateApiKeyConnect,
// disconnectIntegration). The OAuth/API-key flow opens a modal whose
// shape matches the redesign; auto-config + finalize fire after the
// connection lands so the legacy reconcile path still applies.
//
// Pagination — 12 cards per page; the redesign convention.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useQuery,
  getIntegrationCatalog,
  getConnectedIntegrations,
  initiateConnect,
  initiateApiKeyConnect,
  disconnectIntegration,
  autoConfigIntegration,
  finalizeComposioConnections,
  getOpenclawReadiness,
  getIntegrationScope,
  createInboundWebhook,
  deleteInboundWebhook,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import {
  isLastAccountOfToolkit,
  revokeConsequenceCopy,
} from "./connectionsRevokeCore";

// Synthetic toolkit slugs ctrl-api injects into the catalog response —
// they aren't Composio toolkits and need bespoke modal UX.
const OMI_SLUG = "alfred-omi";
const WEBHOOK_SLUG = "alfred-webhook";

interface Toolkit {
  slug: string;
  name: string;
  description: string;
  category: string;
  // ctrl-api's catalog returns `icon_url`; older redesign code read `logo`.
  // Accept both so we don't break either render path.
  logo?: string;
  icon_url?: string;
  // The actual shape from ctrl-api's /api/v1/integrations/catalog.
  // Example values: ["OAUTH2"], ["API_KEY"], ["BEARER_TOKEN"], or [].
  // The old `authConfig: {type, fields}` shape was never produced —
  // reading it always returned undefined and the modal silently defaulted
  // to OAuth, which broke API-key-only toolkits like Exa (Composio
  // refused with "no default auth config" because Exa has no platform
  // OAuth app).
  auth_schemes?: string[];
}

type AuthFlow =
  | "oauth"
  | "api_key"
  | "bearer_token"
  | "device_pair"
  | "inbound_webhook"
  | "unsupported";

function resolveAuthFlow(toolkit: Toolkit | null | undefined): AuthFlow {
  const schemes = new Set(
    (toolkit?.auth_schemes ?? []).map((s) => String(s ?? "").toUpperCase()),
  );
  if (schemes.has("DEVICE_PAIR")) return "device_pair";
  if (schemes.has("INBOUND_WEBHOOK")) return "inbound_webhook";
  if (schemes.has("OAUTH2") || schemes.has("OAUTH1") || schemes.has("OAUTH1A")) {
    return "oauth";
  }
  if (schemes.has("API_KEY")) return "api_key";
  if (schemes.has("BEARER_TOKEN")) return "bearer_token";
  // Composio often omits the field — default to OAuth since most
  // toolkits in the catalogue use it. Matches IntegrationsPage.
  if (schemes.size === 0) return "oauth";
  return "unsupported";
}

interface Connected {
  id: string;
  toolkit: string;
  toolkit_name?: string;
  toolkit_icon?: string;
  status: string;
  auth_scheme?: string;
  created_at?: string;
  is_stream_source?: boolean;
}

const PAGE_SIZE = 12;

export default function ConnectionsPage() {
  const { data: catalogData, isLoading: catalogLoading } = useQuery(
    getIntegrationCatalog,
    { search: "", category: "" },
  );
  const { data: connectedData, refetch: refetchConnected } = useQuery(
    getConnectedIntegrations,
  );
  const { data: readiness } = useQuery(getOpenclawReadiness);

  const toolkits: Toolkit[] = (catalogData?.toolkits ?? []) as Toolkit[];
  const categories: string[] = (catalogData?.categories ?? []) as string[];
  const connected: Connected[] = (connectedData?.integrations ?? []) as Connected[];
  // For OAuth/API-key toolkits one row per slug; for Omi + Webhook the
  // user can have multiple at once (multiple paired devices, multiple
  // webhook endpoints) so the "Connected" state needs a list-per-slug
  // counter, not a single record.
  const connectedBySlug = useMemo(() => {
    const map = new Map<string, Connected[]>();
    for (const c of connected) {
      const list = map.get(c.toolkit);
      if (list) list.push(c);
      else map.set(c.toolkit, [c]);
    }
    return map;
  }, [connected]);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [openApp, setOpenApp] = useState<Toolkit | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Connected | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return toolkits.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (search) {
        const s = search.toLowerCase();
        return (
          t.slug.toLowerCase().includes(s) ||
          t.name.toLowerCase().includes(s) ||
          (t.description ?? "").toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [toolkits, search, category]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  async function startOAuth(toolkit: Toolkit) {
    setBusy(toolkit.slug);
    try {
      // Pass an explicit redirect_url so Composio knows where to send
      // the user after they authorize. Without this Composio falls back
      // to its own default and our callback handler below never fires.
      // Matches the working /dashboard/integrations flow.
      const result: any = await initiateConnect({
        toolkit_slug: toolkit.slug,
        redirect_url: `${window.location.origin}/connections?composio_callback=success&toolkit=${toolkit.slug}`,
      });
      // ctrl-api returns `connect_url` (not `redirect_url`); reading the
      // wrong field was why the OAuth window never opened before.
      const connectUrl: string | undefined = result?.connect_url;
      if (!connectUrl) {
        setBusy(null);
        setToast(`Could not start ${toolkit.name} — no connect URL`);
        return;
      }
      // Named popup so a second click reuses the same window. Polling
      // for popup.closed is the only way to know the user finished —
      // OAuth redirects between Composio + the provider blow away
      // postMessage. After close: poll connection list for the new row
      // becoming ACTIVE, then run auto-config (stream + skill + reload
      // tools.allow). Bounded retry (6 × 2s) covers Composio's
      // INITIATED → ACTIVE race; the callback useEffect catches late
      // arrivals.
      const popup = window.open(
        connectUrl,
        "composio-connect",
        "width=600,height=700,left=200,top=100",
      );
      if (!popup) {
        setBusy(null);
        setToast(`Popup blocked for ${toolkit.name} — please allow popups and retry.`);
        return;
      }
      setToast(`Opening ${toolkit.name}…`);
      const prevIds = new Set(connected.map((c) => c.id));
      const interval = setInterval(async () => {
        if (!popup.closed) return;
        clearInterval(interval);
        for (let attempt = 0; attempt < 6; attempt++) {
          const refreshed = await refetchConnected();
          const newConns: Connected[] = (refreshed?.data?.integrations ?? []) as Connected[];
          const fresh = newConns.find(
            (c) => !prevIds.has(c.id) && c.toolkit === toolkit.slug && c.status === "ACTIVE",
          );
          if (fresh) {
            try {
              await autoConfigIntegration({ connectionId: fresh.id });
              await finalizeComposioConnections();
              setToast(`${toolkit.name} connected.`);
            } catch (e) {
              console.warn("auto-config failed", e);
              setToast(`${toolkit.name} connected — configuring shortly…`);
            }
            setOpenApp(null);
            setBusy(null);
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        // Popup closed without an ACTIVE connection landing in 12s.
        // Could be user cancelled, or Composio is slow — the callback
        // useEffect below will pick it up on the next list refresh.
        setOpenApp(null);
        setBusy(null);
        setToast(`${toolkit.name} — waiting for Composio to confirm…`);
      }, 500);
      // Hard cap: 2 min, then give up on the popup poll regardless.
      setTimeout(() => {
        clearInterval(interval);
        setBusy(null);
      }, 120_000);
    } catch (e) {
      console.error("oauth init failed", e);
      setToast(`Could not start ${toolkit.name}`);
      setBusy(null);
    }
  }

  // Detect callback from the popup's redirect: Composio sends the user
  // back to /connections?composio_callback=success&toolkit=<slug>. The
  // popup-close poll above handles the happy path; this useEffect is
  // the safety net for cases where the popup-close fires before
  // Composio finishes flipping the connection to ACTIVE.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("composio_callback") !== "success") return;
    const toolkitSlug = params.get("toolkit") || "";
    void refetchConnected();
    window.history.replaceState({}, "", "/connections");
    if (toolkitSlug) setToast(`${toolkitSlug} connected!`);
  }, [refetchConnected]);

  async function saveApiKey(toolkit: Toolkit, key: string) {
    setBusy(toolkit.slug);
    try {
      // Pass the explicit auth_scheme so BEARER_TOKEN toolkits don't
      // get exchanged as API_KEY (Composio rejects the mismatch).
      const flow = resolveAuthFlow(toolkit);
      const auth_scheme = flow === "bearer_token" ? "BEARER_TOKEN" : "API_KEY";
      const result: any = await initiateApiKeyConnect({
        toolkit_slug: toolkit.slug,
        credential: key,
        auth_scheme,
      });
      const connectionId = result?.connection_id ?? result?.connectionId;
      if (connectionId) {
        try {
          await autoConfigIntegration({ connectionId });
          await finalizeComposioConnections();
        } catch (e) {
          console.warn("auto-config best-effort failed", e);
        }
      }
      setOpenApp(null);
      setToast(`${toolkit.name} connected.`);
      await refetchConnected();
    } catch (e) {
      console.error("api key connect failed", e);
      setToast(`Could not connect ${toolkit.name}`);
    } finally {
      setBusy(null);
    }
  }

  // F72 — open the in-design revoke modal instead of the native confirm()
  // Chrome popup. The actual revoke runs from the modal's affirmative.
  function disconnect(connection: Connected) {
    setRevokeTarget(connection);
  }

  async function performDisconnect(connection: Connected) {
    const label = connection.toolkit_name || connection.toolkit;
    setBusy(connection.id);
    try {
      // Custom webhooks have their own delete endpoint; everything else
      // (Composio rows + Omi device rows) goes through the unified
      // disconnect path. (Omi disconnect on the tenant side isn't
      // wired yet — see /channels for now.)
      if (connection.id.startsWith("webhook:")) {
        await deleteInboundWebhook({ id: connection.id });
      } else {
        await disconnectIntegration({ connectionId: connection.id });
      }
      setToast(`Disconnected ${label}.`);
      setRevokeTarget(null);
      await refetchConnected();
    } catch (e) {
      console.error("disconnect failed", e);
      setToast(`Could not disconnect ${label}`);
    } finally {
      setBusy(null);
    }
  }

  async function createWebhook(toolkit: Toolkit, label: string) {
    setBusy(toolkit.slug);
    try {
      const result: any = await createInboundWebhook({ label });
      const url = result?.url || "";
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          setToast(`Webhook created — URL copied to clipboard.`);
        } catch {
          setToast(`Webhook created.`);
        }
      } else {
        setToast(`Webhook created.`);
      }
      setOpenApp(null);
      await refetchConnected();
    } catch (e) {
      console.error("webhook create failed", e);
      setToast(`Could not create webhook`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1180px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Apps
          </div>
          <a
            href="/tools"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            Gateway tools →
          </a>
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-3">
          Connect the apps you already use.
        </h1>
        <p
          className="font-body text-[16px] max-w-[60ch] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Each connection adds streams I can read from and tools I can act
          through. I'll only ever do what you've explicitly asked.
        </p>

        {readiness && readiness.openclawReady === false && (
          <div
            className="border border-rule p-4 mb-6 font-body text-[14px]"
            style={{ borderColor: "var(--brass)" }}
          >
            OpenClaw isn't ready yet. New connections will queue and apply
            once the gateway settles.
          </div>
        )}

        <div className="flex items-center gap-4 mb-6 border-t border-rule pt-8">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search apps…"
            className="flex-1 bg-transparent outline-none border-b font-display italic text-[20px] pb-2"
            style={{ borderColor: "var(--rule)" }}
          />
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(0);
            }}
            className="bg-transparent border border-rule px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em]"
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            {filtered.length} app{filtered.length === 1 ? "" : "s"}
          </span>
        </div>

        {catalogLoading ? (
          <p
            className="font-body italic text-[15px]"
            style={{ color: "var(--marginalia)" }}
          >
            Composing the catalogue…
          </p>
        ) : (
          <div className="grid md:grid-cols-3 gap-4">
            {visible.map((t) => {
              const conns = connectedBySlug.get(t.slug) ?? [];
              // Composio toolkits are one-per-slug (a row = the only
              // connection of its kind). Omi + Webhook can have many
              // rows per slug — for those we show count instead of
              // "Connected" and route the click to "Add another" via
              // the modal rather than disconnect.
              const multi = t.slug === OMI_SLUG || t.slug === WEBHOOK_SLUG;
              const conn = conns[0];
              const isBusy = busy === t.slug;
              return (
                <div
                  key={t.slug}
                  className="border border-rule p-5 card-hover flex items-center gap-4"
                >
                  {t.logo ? (
                    <img
                      src={t.logo}
                      alt=""
                      className="w-8 h-8 shrink-0 object-contain"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility =
                          "hidden";
                      }}
                    />
                  ) : (
                    <div
                      className="w-8 h-8 shrink-0 border border-rule font-display italic flex items-center justify-center"
                      style={{ color: "var(--brass)" }}
                    >
                      {t.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[18px] truncate">{t.name}</div>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {t.category || "—"}
                    </div>
                  </div>
                  {conn && !multi ? (
                    <button
                      onClick={() => disconnect(conn)}
                      disabled={isBusy}
                      className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
                      style={{ color: "var(--brass)" }}
                    >
                      {isBusy ? "…" : "Connected"}
                    </button>
                  ) : multi && conns.length > 0 ? (
                    <button
                      onClick={() => setOpenApp(t)}
                      disabled={isBusy}
                      className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
                      style={{ color: "var(--brass)" }}
                    >
                      {isBusy ? "…" : `${conns.length} active · Add`}
                    </button>
                  ) : (
                    <button
                      onClick={() => setOpenApp(t)}
                      disabled={isBusy}
                      className="btn-ghost"
                    >
                      {isBusy ? "…" : "Connect"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em]">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="btn-ghost"
            >
              ← Prev
            </button>
            <span style={{ color: "var(--marginalia)" }}>
              {page + 1} / {pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="btn-ghost"
            >
              Next →
            </button>
          </div>
        )}

        {connected.length > 0 && (
          <ConnectionsTable
            rows={connected}
            onDisconnect={disconnect}
            busyId={busy}
            // Pass the catalogue so the table can look up proper display
            // names ("Slack", "Google Calendar") for rows whose toolkit
            // slug arrives lowercased. Composio's `displayName` already
            // sits on each toolkit; we just need to key by slug.
            toolkits={toolkits}
          />
        )}

        {toast && (
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-rule px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em]"
            style={{ background: "var(--paper)", color: "var(--ink)" }}
          >
            {toast}
          </div>
        )}
      </section>

      {openApp && (
        <ConnectModal
          app={openApp}
          busy={busy === openApp.slug}
          onClose={() => setOpenApp(null)}
          onOAuth={() => startOAuth(openApp)}
          onApiKey={(k) => saveApiKey(openApp, k)}
          onWebhook={(label) => createWebhook(openApp, label)}
        />
      )}

      {revokeTarget && (
        <RevokeModal
          target={revokeTarget}
          isLast={isLastAccountOfToolkit(revokeTarget, connected)}
          busy={busy === revokeTarget.id}
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => performDisconnect(revokeTarget)}
        />
      )}
    </Frame>
  );
}

// F72 — in-design revoke confirmation modal (replaces window.confirm()). Reuses
// the ConnectModal shell; the consequence copy is conditional on whether this
// is the last account of the toolkit, and the affirmative is a distinct red.
function RevokeModal({
  target,
  isLast,
  busy,
  onClose,
  onConfirm,
}: {
  target: Connected;
  isLast: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const label = target.toolkit_name || target.toolkit;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="border border-rule p-8 max-w-[460px] w-full mx-4"
        style={{ background: "var(--paper)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-2xl mb-2">Revoke {label}?</div>
        <p
          className="font-body text-[15px] mb-6"
          style={{ color: "var(--marginalia)" }}
        >
          {revokeConsequenceCopy(label, isLast)}
        </p>
        <div className="flex items-center gap-4">
          <button
            onClick={onConfirm}
            disabled={busy}
            className="btn-brass"
            style={{ background: "#9b2c2c", borderColor: "#9b2c2c", color: "#fff" }}
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
          <button onClick={onClose} disabled={busy} className="btn-link">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectModal({
  app,
  busy,
  onClose,
  onOAuth,
  onApiKey,
  onWebhook,
}: {
  app: Toolkit;
  busy: boolean;
  onClose: () => void;
  onOAuth: () => void;
  onApiKey: (key: string) => void;
  onWebhook: (label: string) => void;
}) {
  const [key, setKey] = useState("");
  const [webhookLabel, setWebhookLabel] = useState("");
  const flow = resolveAuthFlow(app);
  const isApiKey = flow === "api_key" || flow === "bearer_token";
  const isDevicePair = flow === "device_pair";
  const isInboundWebhook = flow === "inbound_webhook";
  const isUnsupported = flow === "unsupported";
  const credentialLabel = flow === "bearer_token" ? "Bearer token" : "API key";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="border border-rule p-8 max-w-[520px] w-full mx-4"
        style={{ background: "var(--paper)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-5">
          {app.logo ? (
            <img src={app.logo} alt="" className="w-8 h-8" />
          ) : (
            <div
              className="w-8 h-8 border border-rule font-display italic flex items-center justify-center"
              style={{ color: "var(--brass)" }}
            >
              {app.name.slice(0, 1)}
            </div>
          )}
          <div>
            <div className="font-display text-2xl">Connect {app.name}</div>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--brass)" }}
            >
              {isUnsupported
                ? "Unsupported"
                : isDevicePair
                  ? "Device pairing"
                  : isInboundWebhook
                    ? "Inbound URL"
                    : isApiKey
                      ? credentialLabel
                      : "OAuth login"}
            </div>
          </div>
        </div>

        {isUnsupported ? (
          <p
            className="font-body text-[15px] mb-4"
            style={{ color: "var(--marginalia)" }}
          >
            {app.name} uses an authentication scheme Alfred doesn't support yet.
          </p>
        ) : isDevicePair ? (
          <div>
            <p
              className="font-body text-[15px] mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              Pair {app.name} from your phone — open the {app.name} app and
              point it at this tenant's gateway. Once paired, the device will
              appear in the connected list below and start streaming.
            </p>
            <button onClick={onClose} className="btn-brass">
              Got it
            </button>
          </div>
        ) : isInboundWebhook ? (
          <div>
            <p
              className="font-body text-[15px] mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              I'll generate a private URL. Any POST you send to it lands as a
              stream event I can curate. Give it a short label so you can tell
              the URLs apart later.
            </p>
            <label
              className="font-mono text-[10px] uppercase tracking-[0.22em] block mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              Label
            </label>
            <input
              autoFocus
              type="text"
              value={webhookLabel}
              onChange={(e) =>
                setWebhookLabel(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-"),
                )
              }
              placeholder="e.g. buildtrack-notifier"
              className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2 mb-5"
              style={{ borderColor: "var(--brass)" }}
            />
            <button
              onClick={() => onWebhook(webhookLabel)}
              disabled={busy || !webhookLabel.trim()}
              className="btn-brass"
            >
              {busy ? "…" : "Create endpoint"}
            </button>
            <p
              className="font-mono text-[10px] uppercase tracking-[0.22em] mt-3"
              style={{ color: "var(--marginalia)" }}
            >
              The URL will be copied to your clipboard once it's ready.
            </p>
          </div>
        ) : isApiKey ? (
          <div>
            <label
              className="font-mono text-[10px] uppercase tracking-[0.22em] block mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              {app.name} {credentialLabel.toLowerCase()}
            </label>
            <input
              autoFocus
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-transparent outline-none border-b font-mono text-[14px] pb-2 mb-5"
              style={{ borderColor: "var(--brass)" }}
            />
            <button
              onClick={() => onApiKey(key)}
              disabled={busy || !key.trim()}
              className="btn-brass"
            >
              {busy ? "…" : `Save ${credentialLabel.toLowerCase()}`}
            </button>
          </div>
        ) : (
          <div>
            <p
              className="font-body text-[15px] mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              You'll be redirected to {app.name} to authorise. Alfred will
              receive read access — and write access only when you ask for it.
            </p>
            <button onClick={onOAuth} disabled={busy} className="btn-brass">
              {busy ? "…" : `Continue to ${app.name} →`}
            </button>
          </div>
        )}

        <button
          onClick={onClose}
          disabled={busy}
          className="font-mono text-[10px] uppercase tracking-[0.22em] mt-6"
          style={{ color: "var(--marginalia)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// ConnectionsTable — "Where I am authorised to act"
// ----------------------------------------------------------------------------
//
// A flat, scoped audit view of every connected stream source. Calls
// getIntegrationScope per row (lightly cached on ctrl-api) so we can show
// read/write action labels — not just status. STREAM badge surfaces rows that
// have actually produced events (the `is_stream_source` flag the unified
// /api/v1/integrations endpoint stamps on each row).

function ConnectionsTable({
  rows,
  onDisconnect,
  busyId,
  toolkits,
}: {
  rows: Connected[];
  onDisconnect: (c: Connected) => void;
  busyId: string | null;
  toolkits: Toolkit[];
}) {
  // Composio's catalog has the right display name for every toolkit
  // ("Slack", "Google Calendar"). The connected list sometimes only has
  // the lowercase slug, so we fall back to the catalog by slug.
  const nameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of toolkits) {
      if (t?.slug && t?.name) m.set(t.slug.toLowerCase(), t.name);
    }
    return m;
  }, [toolkits]);
  return (
    <div className="mt-14">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
        style={{ color: "var(--brass)" }}
      >
        Where I am authorised to act
      </div>
      <h2 className="font-display text-4xl tracking-tight mb-8">
        Connections
      </h2>

      <table className="w-full">
        <thead>
          <tr className="border-t border-b border-rule">
            <Th>Service</Th>
            <Th>Scope</Th>
            <Th align="right">Authorised</Th>
            <Th align="right">Status</Th>
            <Th align="right"> </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ConnectionRow
              key={row.id}
              row={row}
              busy={busyId === row.id}
              onDisconnect={() => onDisconnect(row)}
              displayName={
                row.toolkit_name ||
                nameBySlug.get(row.toolkit.toLowerCase()) ||
                titleCaseSlug(row.toolkit)
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="font-mono text-[10px] uppercase tracking-[0.22em] py-3"
      style={{
        color: "var(--marginalia)",
        textAlign: align,
        fontWeight: 400,
      }}
    >
      {children}
    </th>
  );
}

function ConnectionRow({
  row,
  busy,
  onDisconnect,
  displayName,
}: {
  row: Connected;
  busy: boolean;
  onDisconnect: () => void;
  displayName: string;
}) {
  // ctrl-api caches scope lookups per toolkit for 10 min so we can
  // always-fetch without burning the Composio quota.
  const { data: scope } = useQuery(getIntegrationScope, {
    connectionId: row.id,
  });

  const readList: string[] = Array.isArray(scope?.read) ? scope.read : [];
  const writeList: string[] = Array.isArray(scope?.write) ? scope.write : [];
  const isPending = String(row.status || "").toUpperCase() !== "ACTIVE";

  // Compact scope label: at most ~4 chips, then "+N more". Mix read + write
  // with a leading "read" / "write" verb so the audit reads well.
  const scopeChips: string[] = [];
  if (scope?.note) {
    scopeChips.push(scope.note);
  } else {
    if (readList.length) scopeChips.push(`read · ${summariseActions(readList)}`);
    if (writeList.length) scopeChips.push(`write · ${summariseActions(writeList)}`);
  }
  const scopeText =
    scopeChips.length === 0
      ? scope
        ? "—"
        : "loading…"
      : scopeChips.join(" · ");

  return (
    <tr className="border-b border-rule">
      <td className="py-3 font-display text-[17px]">
        <div className="flex items-center gap-2">
          <span>{displayName}</span>
          {row.is_stream_source && (
            <span
              className="font-mono text-[9px] uppercase tracking-[0.24em] px-1.5 py-0.5 border border-rule"
              style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
              title="This source has emitted stream events Alfred has processed."
            >
              stream
            </span>
          )}
        </div>
      </td>
      <td
        className="py-3 font-mono text-[12px]"
        style={{ color: "var(--ink)" }}
      >
        {scopeText}
      </td>
      <td
        className="py-3 font-mono text-[11px] text-right"
        style={{ color: "var(--marginalia)" }}
      >
        {formatAuthDate(row.created_at)}
      </td>
      <td
        className="py-3 font-mono text-[11px] uppercase tracking-[0.22em] text-right"
        style={{ color: isPending ? "var(--marginalia)" : "var(--brass)" }}
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{
              background: isPending ? "var(--marginalia)" : "var(--brass)",
            }}
          />
          {isPending ? "pending" : "live"}
        </span>
      </td>
      <td className="py-3 text-right">
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          {busy ? "…" : "Revoke"}
        </button>
      </td>
    </tr>
  );
}

function summariseActions(actions: string[]): string {
  // Render up to 4 chips, then "+N more". Strip toolkit prefix if the
  // action labels still have shouty slug form.
  const cleaned = actions
    .slice(0, 6)
    .map((a) =>
      a
        .replace(/^[A-Z0-9_]+_/, "")
        .toLowerCase()
        .replace(/_/g, " "),
    );
  const shown = cleaned.slice(0, 4);
  const extra = actions.length - shown.length;
  return extra > 0 ? `${shown.join(" · ")} · +${extra} more` : shown.join(" · ");
}

function formatAuthDate(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    // "13 May 2026" — letterpress-style long form. en-GB locale gives
    // day-first ordering without the trailing comma en-US would add.
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return "—";
  }
}

// Slug → human title last-resort. The catalog lookup handles the common
// case (`googlecalendar` → "Google Calendar"); this only fires when even
// the catalog doesn't know — typically for transient slugs we haven't
// seen yet. Capitalises each word, splits on - / _ / .
function titleCaseSlug(slug: string): string {
  if (!slug) return "";
  return slug
    .replace(/[-_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
