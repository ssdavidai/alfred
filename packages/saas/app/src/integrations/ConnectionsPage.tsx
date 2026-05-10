// ConnectionsPage — Composio catalogue, restyled (#863).
//
// Wraps the existing integration ops (getIntegrationCatalog,
// getConnectedIntegrations, initiateConnect, initiateApiKeyConnect,
// disconnectIntegration). The OAuth/API-key flow opens a modal whose
// shape matches the redesign; auto-config + finalize fire after the
// connection lands so the legacy reconcile path still applies.
//
// Pagination — 12 cards per page; the redesign convention.
import { useEffect, useMemo, useState } from "react";
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
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

interface Toolkit {
  slug: string;
  name: string;
  description: string;
  category: string;
  logo?: string;
  authConfig?: {
    type?: string;
    fields?: Array<{ name: string; required?: boolean }>;
  } | null;
}

interface Connected {
  id: string;
  toolkit: string;
  status: string;
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
  const connectedBySlug = useMemo(() => {
    const map = new Map<string, Connected>();
    for (const c of connected) map.set(c.toolkit, c);
    return map;
  }, [connected]);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [openApp, setOpenApp] = useState<Toolkit | null>(null);
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
      const result: any = await initiateConnect({ toolkit_slug: toolkit.slug });
      if (result?.redirect_url || result?.redirectUrl) {
        const url = result.redirect_url || result.redirectUrl;
        window.open(url, "_blank", "noopener");
      }
      setOpenApp(null);
      setToast(`Opening ${toolkit.name}…`);
      await refetchConnected();
    } catch (e) {
      console.error("oauth init failed", e);
      setToast(`Could not start ${toolkit.name}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveApiKey(toolkit: Toolkit, key: string) {
    setBusy(toolkit.slug);
    try {
      const result: any = await initiateApiKeyConnect({
        toolkit_slug: toolkit.slug,
        credential: key,
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

  async function disconnect(connection: Connected) {
    if (!confirm(`Disconnect ${connection.toolkit}?`)) return;
    setBusy(connection.toolkit);
    try {
      await disconnectIntegration({ connectionId: connection.id });
      setToast(`Disconnected ${connection.toolkit}.`);
      await refetchConnected();
    } catch (e) {
      console.error("disconnect failed", e);
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
              const conn = connectedBySlug.get(t.slug);
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
                  {conn ? (
                    <button
                      onClick={() => disconnect(conn)}
                      disabled={isBusy}
                      className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
                      style={{ color: "var(--brass)" }}
                    >
                      {isBusy ? "…" : "Connected"}
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
        />
      )}
    </Frame>
  );
}

function ConnectModal({
  app,
  busy,
  onClose,
  onOAuth,
  onApiKey,
}: {
  app: Toolkit;
  busy: boolean;
  onClose: () => void;
  onOAuth: () => void;
  onApiKey: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  const authType = String(app.authConfig?.type ?? "OAUTH2").toUpperCase();
  const isApiKey = authType.includes("API") || authType === "BEARER_TOKEN";

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
              {isApiKey ? "API key" : "OAuth login"}
            </div>
          </div>
        </div>

        {isApiKey ? (
          <div>
            <label
              className="font-mono text-[10px] uppercase tracking-[0.22em] block mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              {app.name} API key
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
              {busy ? "…" : "Save key"}
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
