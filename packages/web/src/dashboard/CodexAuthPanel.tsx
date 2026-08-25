// Codex credential panel — /study#agent.
//
// Answers the question the dashboard could not previously answer: is each
// supervised Hermes profile actually authenticated, and give me a button.
//
// The existing HermesAuthBanner only appears when Hermes *health* is degraded,
// which never fires for the failure that actually happens: gateways answering
// 200 while the credential underneath is empty or expired. This panel is
// always reachable, so a principal can check and re-auth without waiting for a
// banner that will not come.

import { useEffect, useState } from "react";
import { useQuery, getCodexAuthProfiles, getCodexAuthStatus, startCodexAuth } from "wasp/client/operations";
import { deriveProfileViews } from "./codexProfilesCore";

const POLL_IDLE_MS = 60_000;
const POLL_ACTIVE_MS = 2_500;

export default function CodexAuthPanel() {
  const [flowActive, setFlowActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: profilesData, refetch: refetchProfiles } = useQuery(
    getCodexAuthProfiles,
    undefined,
    { refetchInterval: flowActive ? POLL_ACTIVE_MS : POLL_IDLE_MS, retry: false },
  );
  const { data: statusData } = useQuery(getCodexAuthStatus, undefined, {
    refetchInterval: flowActive ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    retry: false,
  });

  const views = deriveProfileViews(profilesData);
  const status = (statusData ?? {}) as {
    status?: string;
    user_code?: string;
    verification_uri?: string;
    error?: string;
  };

  // Stop fast-polling once the ceremony reaches a terminal state, and pick up
  // the new credential in the rows. In an effect, not during render — setting
  // state while rendering re-enters and can loop.
  const terminal = ["complete", "failed", "timeout"].includes(status.status ?? "");
  useEffect(() => {
    if (!flowActive || !terminal) return;
    setFlowActive(false);
    void refetchProfiles();
  }, [flowActive, terminal, refetchProfiles]);

  async function onConnect() {
    setBusy(true);
    setErr(null);
    try {
      await (startCodexAuth as (a: Record<string, never>) => Promise<unknown>)({});
      setFlowActive(true);
    } catch (e: any) {
      setErr(e?.message ?? "Could not start authentication");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-2 border-b border-ink pb-1 mb-4">
        Codex authentication
      </h3>

      {views.length === 0 ? (
        <p className="font-serif text-sm text-ink-2">
          Credential state is unavailable — the runtime did not answer.
        </p>
      ) : (
        <ul className="mb-6">
          {views.map((v) => (
            <li
              key={v.profile}
              className="flex items-baseline justify-between gap-4 border-b border-rule py-2"
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.12em]">
                {v.profile}
              </span>
              <span className="flex items-baseline gap-3 text-right">
                <span className="font-serif text-sm text-ink-2">{v.detail}</span>
                <span
                  className={
                    "font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 border " +
                    (v.authenticated
                      ? "border-rule text-ink-2"
                      : "border-ink bg-ink text-paper")
                  }
                >
                  {v.label}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {status.status === "awaiting_approval" && status.user_code ? (
        <div className="font-serif text-sm leading-relaxed mb-4">
          Enter <span className="font-mono bg-ink text-paper px-1">{status.user_code}</span> at{" "}
          <a className="underline" href={status.verification_uri} target="_blank" rel="noreferrer">
            {status.verification_uri}
          </a>
          , then come back — this panel updates itself.
        </div>
      ) : null}

      {err || status.error ? (
        <p className="font-serif text-sm mb-4">Authentication failed: {err ?? status.error}.</p>
      ) : null}

      <button
        type="button"
        onClick={onConnect}
        disabled={busy || flowActive}
        className="font-mono text-[11px] uppercase tracking-[0.06em] border-[1.5px] border-ink px-3 py-1.5 shadow-[2px_2px_0_var(--ab-ink)] disabled:opacity-50"
      >
        {flowActive ? "Waiting for approval…" : busy ? "Starting…" : "Connect with Codex"}
      </button>
    </div>
  );
}
