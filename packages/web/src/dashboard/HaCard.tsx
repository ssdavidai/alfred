// HaCard — the Home Assistant /channels surface.
//
// #110 PR3 (2026-05-29). The React layer for the deep-integration card;
// state derivation lives in haCardCore.ts (pure, import-free, unit-tested
// under node:test). Backed by ctrl-api /api/v1/channels/ha/* (PR1 #133
// landed connect/status/disconnect/registry; PR4 adds /runs; PR5 backfills
// the registry).
//
// Five views map to the five ctrl-api `state` values:
//
//   • unconfigured/disconnected → connect form (HA URL + LLAT textarea +
//                                 a HACS hint pointing at ssdavidai/alfred-ha)
//   • connecting                → spinner + URL being probed, polls /status
//                                 every 3s
//   • connected                 → ha_url, ha_version, registry counts,
//                                 expanders for "Registry" / "Recent runs" /
//                                 "Voice surface" / "Disconnect"
//   • error                     → last_error verbatim + retry + disconnect
//
// SECURITY: the LLAT is a ~180-char JWT-shaped Home Assistant long-lived
// access token. It must NEVER appear in any UI element, log line, error
// toast, commit, or PR body. This file:
//
//   * uses a <textarea> with autoComplete="off" + spellCheck={false}
//     (LLATs don't fit a single-line input)
//   * never re-displays the pasted token (no "show password" toggle, no
//     echo in any toast, no serialisation into React state log)
//   * clears the local React state holding the LLAT immediately on
//     submit success, so the value stops living in the React tree
//   * routes any in-toast surfacing through redactLlat() which only
//     leaks the first 8 chars
//
// ctrl-api's /status route does NOT echo the LLAT; it only carries the
// vault_item_id in state.db.

import { useEffect, useReducer, useState } from "react";
import {
  useQuery,
  getHaStatus,
  getHaRegistry,
  getHaGaps,
  getHaProposals,
  connectHa,
  disconnectHa,
  refreshHaRegistry,
  applyHaProposal,
  dismissHaGap,
  rejectHaProposal,
} from "wasp/client/operations";
import {
  deriveHaCardState,
  isProbablyValidLlat,
  labelForGapKind,
  parseHaUrl,
  proposalModalReduce,
  PROPOSAL_MODAL_CLOSED,
  redactLlat,
  summariseGaps,
  summariseProposals,
  summariseRegistry,
  type HaGapRow,
  type HaGapsResponse,
  type HaProposalRow,
  type HaProposalsResponse,
  type HaRegistry,
  type HaStatus,
} from "./haCardCore";

// Re-use the ChannelCard chrome from ChannelsPage. Pulling the JSX-only
// wrapper through a prop-driven function keeps HaCard.tsx self-contained
// without re-implementing the pill / heading / address layout.
//
// We mirror the inline cards (TelegramCard, OmiCard, PaperclipCard, …)
// by re-rendering the same .border / .p-6 / .card-hover shell ourselves.
// The styling stays in sync because both shells read the same CSS vars.

type ChannelStatus = "active" | "available" | "soon" | "starting" | "error";

function ChannelCard({
  name,
  address,
  note,
  status,
  children,
}: {
  name: string;
  address: string;
  note: string;
  status: ChannelStatus;
  children?: React.ReactNode;
}) {
  const pillColor =
    status === "active" || status === "error"
      ? "var(--brass)"
      : "var(--marginalia)";
  const pillText =
    status === "active"
      ? "Connected"
      : status === "soon"
        ? "Coming soon"
        : status === "starting"
          ? "Starting"
          : status === "error"
            ? "Needs attention"
            : "Not connected";
  return (
    <div className="border border-rule p-6 card-hover h-full">
      <div className="flex items-baseline justify-between mb-3">
        <span className="font-display text-3xl">{name}</span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
          style={{ color: pillColor }}
        >
          {pillText}
        </span>
      </div>
      <div
        className="font-mono text-[12px] mb-3"
        style={{ color: "var(--ink)" }}
      >
        {address}
      </div>
      <div className="font-body italic" style={{ color: "var(--marginalia)" }}>
        {note}
      </div>
      {children}
    </div>
  );
}

// The voice-bridge `self` allowlist contract (#110 PR1 spec §7 Q13) — the
// four read routes the voice surface can call against HA. Surfaced in the
// "Voice surface" expander so the operator can see at a glance what
// Alfred-the-voice can read from HA without their explicit per-turn
// approval.
const VOICE_SURFACE_TOOLS: Array<{ route: string; what: string }> = [
  {
    route: "GET /api/v1/channels/ha/status",
    what: "Is HA connected? What's the version?",
  },
  {
    route: "GET /api/v1/channels/ha/registry",
    what: "Read the entity / device / area / automation registry.",
  },
  {
    route: "GET /api/v1/channels/ha/automations",
    what: "List automation entities and their last-fired times.",
  },
  {
    route: "GET /api/v1/channels/ha/state/:entity_id",
    what: "Read the current state of a single entity (no writes).",
  },
];

const REGISTRY_PREVIEW_LIMIT = 20;
const STATUS_POLL_MS = 3_000;

export function HaCard() {
  const { data: statusData, refetch: refetchStatus } = useQuery(
    getHaStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as HaStatus | undefined) ?? null;
  const card = deriveHaCardState({ status });

  // The registry is only meaningful in the connected view, so we wire the
  // useQuery to start enabled-once-connected. Wasp's useQuery does not
  // expose `enabled`, but a 404 / empty response from ctrl-api is the
  // bootstrap-not-run-yet signal — we render the empty-state copy in
  // that branch instead of hiding the section.
  const { data: registryData, refetch: refetchRegistry } = useQuery(
    getHaRegistry,
    undefined,
    { retry: false },
  );
  const registry = (registryData as HaRegistry | undefined) ?? null;
  const summary = summariseRegistry(registry);

  // #110 PR6 — gaps + proposals. Empty {open:[],closed:[]} / {pending:[]…}
  // shape on cold start; the polling cadence is driven by the refresh CTA
  // (we refetch ~35s after a refresh queues, same window as the registry).
  const { data: gapsData, refetch: refetchGaps } = useQuery(
    getHaGaps,
    undefined,
    { retry: false },
  );
  const gaps = (gapsData as HaGapsResponse | undefined) ?? null;
  const gapSummary = summariseGaps(gaps);

  const { data: proposalsData, refetch: refetchProposals } = useQuery(
    getHaProposals,
    undefined,
    { retry: false },
  );
  const proposals =
    (proposalsData as HaProposalsResponse | undefined) ?? null;
  const proposalSummary = summariseProposals(proposals);

  // Proposal modal — reducer-driven so the state machine is unit-tested
  // (proposalModalReduce in haCardCore.ts).
  const [modal, dispatchModal] = useReducer(
    proposalModalReduce,
    PROPOSAL_MODAL_CLOSED,
  );

  // Per-gap dismiss spinners — keyed by gap id.
  const [gapBusy, setGapBusy] = useState<Set<string>>(new Set());

  // Connect-form state (kept local; never persisted).
  const [haUrl, setHaUrl] = useState("");
  const [haUrlError, setHaUrlError] = useState<string | null>(null);
  const [llat, setLlat] = useState("");
  const [label, setLabel] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  // Disconnect state.
  const [discBusy, setDiscBusy] = useState(false);

  // Refresh-registry state (#110 PR5). The CTA triggers a one-shot
  // HaBootstrapWorkflow run via ctrl-api; the workflow takes ~30s on
  // a small HA install. We disable the button while the request is
  // in flight; after the request resolves we keep the "Refreshing…"
  // label for a short cooldown so a double-click can't fire two
  // workflows back to back.
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Expanders.
  const [registryOpen, setRegistryOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  // Poll /status every 3s while connecting.
  useEffect(() => {
    if (!card.shouldPoll) return;
    const handle = setInterval(() => {
      refetchStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(handle);
  }, [card.shouldPoll, refetchStatus]);

  // When we transition into connected, fetch the registry once so the
  // counts populate without the operator having to expand the section.
  useEffect(() => {
    if (card.mode === "connected") {
      refetchRegistry();
    }
  }, [card.mode, refetchRegistry]);

  function onHaUrlBlur() {
    if (haUrl.trim().length === 0) {
      setHaUrlError(null);
      return;
    }
    const parsed = parseHaUrl(haUrl);
    setHaUrlError(parsed.ok ? null : parsed.error);
  }

  const llatTrimmed = llat.trim();
  const llatLooksLikeJwt = isProbablyValidLlat(llatTrimmed);
  const llatHint =
    llatTrimmed.length > 0 && !llatLooksLikeJwt
      ? "That doesn't look JWT-shaped — HA tokens start with eyJ and have two dots."
      : null;

  async function onConnect() {
    setConnectErr(null);
    const parsed = parseHaUrl(haUrl);
    if (!parsed.ok || !parsed.url) {
      setHaUrlError(parsed.error);
      return;
    }
    if (llatTrimmed.length === 0) {
      setConnectErr("LLAT is required.");
      return;
    }
    setConnectBusy(true);
    try {
      await connectHa({
        ha_url: parsed.url,
        llat: llatTrimmed,
        label: label.trim() || undefined,
      });
      // SECURITY: clear the token from React state IMMEDIATELY on
      // success. The server response by contract does NOT echo the
      // LLAT, but we still wipe the local copy so it stops living in
      // the React tree.
      setLlat("");
      setHaUrl("");
      setLabel("");
      refetchStatus();
      refetchRegistry();
    } catch (e: any) {
      // SECURITY: redactLlat is the ONLY formatter allowed to touch
      // the in-memory token. Even on error we leak no more than the
      // first 8 chars, and only when the operator pasted something.
      const prefix = redactLlat(llatTrimmed);
      const base =
        e?.message ?? e?.data?.error ?? "Couldn't connect to Home Assistant.";
      setConnectErr(prefix ? `${base} (token ${prefix})` : base);
    } finally {
      setConnectBusy(false);
    }
  }

  async function onRefreshRegistry() {
    if (refreshBusy) return;
    setRefreshBusy(true);
    setRefreshMsg(null);
    try {
      const r = (await refreshHaRegistry({})) as
        | { ok?: boolean; workflow_id?: string; eta?: string }
        | undefined;
      const eta = r?.eta ?? "30s";
      setRefreshMsg(`Refresh queued — Alfred will pull again in ~${eta}.`);
      // Re-fetch the registry after the typical workflow window so
      // the counts populate without the operator having to click again.
      window.setTimeout(() => {
        refetchRegistry();
      }, 35_000);
    } catch (e) {
      setRefreshMsg(
        "Couldn't queue a refresh. Try again in a moment, or check that " +
          "alfred-learn is healthy.",
      );
      console.error("ha refresh failed", e);
    } finally {
      // Short cooldown so a quick double-click doesn't fire two
      // workflows back to back. The button stays disabled for 5s.
      window.setTimeout(() => {
        setRefreshBusy(false);
      }, 5_000);
    }
  }

  async function onDismissGap(gap: HaGapRow) {
    const id = gap.id;
    if (!id) return;
    if (gapBusy.has(id)) return;
    setGapBusy((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await dismissHaGap({ gapId: id });
      refetchGaps();
    } catch (e) {
      console.error("ha gap dismiss failed", e);
    } finally {
      setGapBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function onOpenProposalForGap(gap: HaGapRow) {
    // Look up the proposal whose gap_id matches; fall back to a
    // matching-kind proposal if Phase C hasn't refreshed the FK yet.
    if (!proposals) return;
    const byGap = proposals.pending.find((p) => p.gap_id === gap.id);
    if (byGap) {
      dispatchModal({ type: "OPEN", proposal: byGap });
      return;
    }
    const byKind = proposals.pending.find((p) => p.kind === gap.kind);
    if (byKind) {
      dispatchModal({ type: "OPEN", proposal: byKind });
    }
  }

  async function onApplyProposal() {
    if (!modal.proposal) return;
    dispatchModal({ type: "APPLY" });
    try {
      await applyHaProposal({ proposalId: modal.proposal.id });
      dispatchModal({ type: "APPLY_OK" });
      refetchProposals();
      refetchGaps();
    } catch (e: any) {
      const message =
        e?.message ?? e?.data?.error ?? "Couldn't apply that proposal.";
      dispatchModal({ type: "FAIL", error: String(message) });
    }
  }

  async function onRejectProposal() {
    if (!modal.proposal) return;
    dispatchModal({ type: "REJECT" });
    try {
      await rejectHaProposal({ proposalId: modal.proposal.id });
      dispatchModal({ type: "REJECT_OK" });
      refetchProposals();
    } catch (e: any) {
      const message =
        e?.message ?? e?.data?.error ?? "Couldn't reject that proposal.";
      dispatchModal({ type: "FAIL", error: String(message) });
    }
  }

  async function onDisconnect() {
    if (discBusy) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Disconnect Home Assistant? The LLAT is removed from Vaultwarden " +
          "and the discovered registry is forgotten.",
      )
    ) {
      return;
    }
    setDiscBusy(true);
    try {
      await disconnectHa({});
      setRegistryOpen(false);
      setRunsOpen(false);
      setVoiceOpen(false);
      refetchStatus();
    } catch (e) {
      // Disconnect errors are very rare (vault-cli down) — surface a
      // calm message without the LLAT (the LLAT isn't even in the
      // delete payload).
      console.error("ha disconnect failed", e);
    } finally {
      setDiscBusy(false);
    }
  }

  const address =
    card.state === "connected"
      ? status?.ha_url ||
        (status?.ha_version ? `HA ${status.ha_version}` : "Connected")
      : card.state === "connecting"
        ? "Probing your HA install…"
        : card.state === "error"
          ? "Needs attention"
          : "Not connected — paste a URL + LLAT below";

  return (
    <ChannelCard
      name="Home Assistant"
      address={address}
      note="Operator deep-integrates HA — Alfred reads the registry, proposes baselines, never writes without approval."
      status={card.pill}
    >
      {/* UNCONFIGURED / DISCONNECTED — connect form + HACS hint. */}
      {card.mode === "unconfigured" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {/* HACS hint card pointing at ssdavidai/alfred-ha. The custom
              component is the substrate for the conversation-agent
              (#111) and voice-bridge (#112) lanes; without it the LLAT
              alone is not enough. */}
          <div
            className="border border-rule p-3 text-[12px] font-body"
            style={{ color: "var(--marginalia)" }}
          >
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1"
              style={{ color: "var(--brass)" }}
            >
              Step 0 — install the custom component
            </div>
            <p>
              In Home Assistant, add{" "}
              <a
                href="https://github.com/ssdavidai/alfred-ha"
                target="_blank"
                rel="noreferrer"
                className="underline"
                style={{ color: "var(--ink)" }}
              >
                ssdavidai/alfred-ha
              </a>{" "}
              as a custom HACS repository, then download a long-lived
              token from{" "}
              <span className="font-mono">
                User Profile → Security → Long-Lived Access Tokens
              </span>
              .
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                HA URL
              </div>
              <input
                type="text"
                value={haUrl}
                onChange={(e) => {
                  setHaUrl(e.target.value);
                  if (haUrlError) setHaUrlError(null);
                }}
                onBlur={onHaUrlBlur}
                placeholder="http://homeassistant.local:8123"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              {haUrlError && (
                <p
                  className="font-body italic text-[12px]"
                  style={{ color: "var(--brass)" }}
                >
                  {haUrlError}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Long-Lived Access Token
              </div>
              {/* SECURITY: a textarea (not single-line input) because the
                  LLAT is ~180 chars; spellCheck/autoComplete off so the
                  browser doesn't try to remember it. The value is wiped
                  from React state immediately on submit success. We
                  intentionally do NOT offer a "show" toggle — the only
                  formatter allowed for the in-memory token is
                  redactLlat() (first 8 chars). */}
              <textarea
                value={llat}
                onChange={(e) => setLlat(e.target.value)}
                placeholder="eyJ…"
                autoComplete="off"
                spellCheck={false}
                rows={3}
                className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
              />
              {llatHint && (
                <p
                  className="font-body italic text-[12px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {llatHint}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Label (optional)
              </div>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Home"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
            </div>

            <div className="flex items-baseline gap-3">
              <button
                onClick={onConnect}
                disabled={
                  connectBusy ||
                  haUrl.trim().length === 0 ||
                  llatTrimmed.length === 0 ||
                  !!haUrlError
                }
                className="btn-ghost"
              >
                {connectBusy ? "Connecting…" : "Connect"}
              </button>
            </div>

            {connectErr && (
              <p
                className="font-body italic text-[13px]"
                style={{ color: "var(--brass)" }}
              >
                {connectErr}
              </p>
            )}
          </div>
        </div>
      )}

      {/* CONNECTING — spinner copy + the URL being probed. Polls /status. */}
      {card.mode === "connecting" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          <div className="flex items-baseline gap-3 pt-1">
            <span
              className="font-mono text-[11px]"
              style={{ color: "var(--marginalia)" }}
            >
              Polling status every 3s…
            </span>
            {card.showDisconnect && (
              <button
                onClick={onDisconnect}
                disabled={discBusy}
                className="btn-link"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* CONNECTED — ha_url, ha_version, registry counts, expanders. */}
      {card.mode === "connected" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          <div className="space-y-1 font-mono text-[12px]">
            {status?.ha_url && (
              <div className="flex gap-2">
                <span style={{ color: "var(--marginalia)" }}>url</span>
                <span style={{ color: "var(--ink)" }}>{status.ha_url}</span>
              </div>
            )}
            {status?.ha_version && (
              <div className="flex gap-2">
                <span style={{ color: "var(--marginalia)" }}>version</span>
                <span style={{ color: "var(--ink)" }}>
                  HA {status.ha_version}
                </span>
              </div>
            )}
            {status?.label && (
              <div className="flex gap-2">
                <span style={{ color: "var(--marginalia)" }}>label</span>
                <span style={{ color: "var(--ink)" }}>{status.label}</span>
              </div>
            )}
          </div>

          {/* At-a-glance counts. summariseRegistry handles empty/missing
              buckets safely — the PR5 backfill is what brings these
              above zero. */}
          <div
            className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 font-mono text-[12px] pt-1"
            style={{ color: "var(--ink)" }}
          >
            <RegistryCount label="lights" n={summary.counts.lights} />
            <RegistryCount label="switches" n={summary.counts.switches} />
            <RegistryCount label="scenes" n={summary.counts.scenes} />
            <RegistryCount label="sensors" n={summary.counts.sensors} />
            <RegistryCount label="climate" n={summary.counts.climate} />
            <RegistryCount label="cover" n={summary.counts.cover} />
            <RegistryCount
              label="media_player"
              n={summary.counts.media_player}
            />
            <RegistryCount label="areas" n={summary.areaCount} />
            <RegistryCount label="devices" n={summary.deviceCount} />
            <RegistryCount
              label="automations"
              n={summary.automationCount}
            />
          </div>

          {/* Expander row. */}
          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            <button
              onClick={() => setRegistryOpen((v) => !v)}
              className="btn-link"
            >
              {registryOpen ? "Hide registry" : "Registry"}
            </button>
            <button
              onClick={() => setRunsOpen((v) => !v)}
              className="btn-link"
            >
              {runsOpen ? "Hide recent runs" : "Recent runs"}
            </button>
            <button
              onClick={() => setVoiceOpen((v) => !v)}
              className="btn-link"
            >
              {voiceOpen ? "Hide voice surface" : "Voice surface"}
            </button>
            <button
              onClick={onRefreshRegistry}
              disabled={refreshBusy}
              className="btn-link"
              title="Pulls the latest entities/areas/devices from HA. Auto-runs every 6h."
            >
              {refreshBusy ? "Refreshing…" : "Refresh registry"}
            </button>
            <button
              onClick={onDisconnect}
              disabled={discBusy}
              className="btn-ghost"
            >
              {discBusy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>

          {/* Refresh confirmation copy — letterpress cadence, no
              flashing toast. Cleared on disconnect or next refresh. */}
          {refreshMsg && (
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              {refreshMsg}
            </p>
          )}

          {/* Registry expander — top 20 entities with friendly_name +
              entity_id. PR5 populates this; until then we show the
              empty-state copy. */}
          {registryOpen && (
            <RegistrySection registry={registry} />
          )}

          {/* Recent-runs expander — PR4 ships /runs. Today we render a
              calm placeholder so the connected-state view doesn't have
              a broken expander. */}
          {runsOpen && <RunsSection />}

          {/* Voice-surface expander — the 4 read routes voice-bridge can
              call against HA per the #110 PR1 spec. */}
          {voiceOpen && <VoiceSurfaceSection />}

          {/* #110 PR6 — Alfred-sees-these-gaps section. Always rendered
              in the connected view; an empty registry still shows the
              calm "Alfred is still listening" copy via summariseGaps. */}
          <GapsSection
            gaps={gaps}
            summary={gapSummary}
            busy={gapBusy}
            onOpenProposal={onOpenProposalForGap}
            onDismiss={onDismissGap}
          />

          {/* #110 PR6 — Pending proposals section. */}
          <ProposalsSection
            proposals={proposals}
            summary={proposalSummary}
            onOpen={(p) => dispatchModal({ type: "OPEN", proposal: p })}
          />
        </div>
      )}

      {/* Proposal modal — letterpress overlay with YAML preview + apply/reject CTAs. */}
      {modal.mode !== "closed" && modal.proposal && (
        <ProposalModal
          state={modal}
          onApply={onApplyProposal}
          onReject={onRejectProposal}
          onClose={() => dispatchModal({ type: "CLOSE" })}
          onRetry={() => dispatchModal({ type: "RETRY" })}
        />
      )}

      {/* ERROR — verbatim last_error + retry CTA + disconnect. */}
      {card.mode === "error" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          {card.errorMessage && card.errorMessage !== card.description && (
            <p
              className="font-mono text-[11px]"
              style={{ color: "var(--marginalia)" }}
            >
              {card.errorMessage}
            </p>
          )}
          <div className="flex flex-wrap gap-3 items-baseline">
            {card.showRetry && (
              <button
                onClick={() => refetchStatus()}
                className="btn-ghost"
                disabled={connectBusy}
              >
                Try again
              </button>
            )}
            {card.showDisconnect && (
              <button
                onClick={onDisconnect}
                disabled={discBusy}
                className="btn-link"
              >
                {discBusy ? "Disconnecting…" : "Disconnect"}
              </button>
            )}
          </div>
        </div>
      )}
    </ChannelCard>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function RegistryCount({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex gap-2">
      <span style={{ color: "var(--marginalia)" }}>{label}</span>
      <span>{n}</span>
    </div>
  );
}

function RegistrySection({ registry }: { registry: HaRegistry | null }) {
  // PR5 populates ha_registry; PR3 just displays. When empty we explain
  // why so the operator doesn't think anything is broken.
  const entities = Array.isArray(registry?.entities)
    ? registry!.entities.slice(0, REGISTRY_PREVIEW_LIMIT)
    : [];
  const totalEntities = Array.isArray(registry?.entities)
    ? registry!.entities.length
    : 0;

  if (totalEntities === 0) {
    return (
      <div className="border-t border-rule pt-3 space-y-1">
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          The registry is empty. HaBootstrapWorkflow (PR5) populates entities
          on connect — until that PR lands, this section will be quiet.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-rule pt-3 space-y-1">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] pb-1"
        style={{ color: "var(--marginalia)" }}
      >
        Entities (top {entities.length} of {totalEntities})
      </div>
      {entities.map((e, idx) => {
        const id = e.entity_id || e.ha_id || "";
        const name = e.friendly_name || id || "—";
        return (
          <div
            key={id || idx}
            className="flex items-baseline gap-3 font-mono text-[11px]"
          >
            <span style={{ color: "var(--ink)" }}>{name}</span>
            {id && id !== name && (
              <span style={{ color: "var(--marginalia)" }}>{id}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RunsSection() {
  // The /runs route ships in #110 PR4. PR3's connected view must NOT
  // crash on the 404; we show a friendly placeholder instead. When PR4
  // lands, this component will switch to a useQuery(getHaRuns) call and
  // render pickRecentRuns(rows).
  return (
    <div className="border-t border-rule pt-3 space-y-1">
      <p
        className="font-body italic text-[12px]"
        style={{ color: "var(--marginalia)" }}
      >
        Recent-runs surface arrives in PR4 — the service-call / automation
        / proposal-apply ledger. Until then, this section is intentionally
        quiet.
      </p>
    </div>
  );
}

function GapsSection({
  gaps,
  summary,
  busy,
  onOpenProposal,
  onDismiss,
}: {
  gaps: HaGapsResponse | null;
  summary: ReturnType<typeof summariseGaps>;
  busy: Set<string>;
  onOpenProposal: (gap: HaGapRow) => void;
  onDismiss: (gap: HaGapRow) => void;
}) {
  const open = Array.isArray(gaps?.open) ? gaps!.open : [];
  if (summary.totalOpen === 0 && summary.totalClosed === 0) {
    return (
      <div className="border-t border-rule pt-3 space-y-1">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em] pb-1"
          style={{ color: "var(--marginalia)" }}
        >
          Alfred sees these gaps
        </div>
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing yet — Alfred re-runs the audit every 6h. The next pass
          will surface any missing baselines.
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-rule pt-3 space-y-2">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: "var(--marginalia)" }}
      >
        Alfred sees these gaps ({summary.totalOpen} open
        {summary.highCount > 0 ? `, ${summary.highCount} high` : ""})
      </div>
      {open.map((gap) => {
        const id = gap.id ?? "";
        const sev = gap.severity ?? "low";
        const sevColor =
          sev === "high"
            ? "var(--brass)"
            : sev === "medium"
              ? "var(--ink)"
              : "var(--marginalia)";
        return (
          <div
            key={id || `${gap.kind}-${gap.area_id ?? ""}`}
            className="flex items-baseline gap-3 font-mono text-[11px]"
          >
            <span style={{ color: sevColor }}>{labelForGapKind(gap.kind)}</span>
            <span
              className="flex-1 italic"
              style={{ color: "var(--marginalia)" }}
            >
              {gap.summary}
            </span>
            <button
              onClick={() => onOpenProposal(gap)}
              className="btn-link"
              title="Open the templated proposal for this gap."
            >
              Open proposal
            </button>
            <button
              onClick={() => onDismiss(gap)}
              disabled={!id || busy.has(id)}
              className="btn-link"
              title="Hide this gap. Alfred won't re-surface it."
            >
              {busy.has(id) ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ProposalsSection({
  proposals,
  summary,
  onOpen,
}: {
  proposals: HaProposalsResponse | null;
  summary: ReturnType<typeof summariseProposals>;
  onOpen: (p: HaProposalRow) => void;
}) {
  const pending = Array.isArray(proposals?.pending) ? proposals!.pending : [];
  if (pending.length === 0 && summary.appliedCount === 0) {
    return null;
  }
  return (
    <div className="border-t border-rule pt-3 space-y-2">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: "var(--marginalia)" }}
      >
        Pending proposals ({pending.length}
        {summary.appliedCount > 0
          ? ` · ${summary.appliedCount} applied`
          : ""}
        )
      </div>
      {pending.length === 0 ? (
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          No pending proposals. Alfred queues a new one as gaps come back.
        </p>
      ) : (
        pending.map((p) => (
          <div
            key={p.id}
            className="flex items-baseline gap-3 font-mono text-[11px]"
          >
            <span style={{ color: "var(--ink)" }}>{labelForGapKind(p.kind)}</span>
            <span
              className="flex-1 italic"
              style={{ color: "var(--marginalia)" }}
            >
              {p.summary}
            </span>
            <button
              onClick={() => onOpen(p)}
              className="btn-link"
              title="View YAML preview, apply, or reject."
            >
              Review
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function ProposalModal({
  state,
  onApply,
  onReject,
  onClose,
  onRetry,
}: {
  state: ReturnType<typeof proposalModalReduce>;
  onApply: () => void;
  onReject: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  // The state machine guarantees state.proposal is non-null when mode
  // is anything other than "closed".
  const p = state.proposal;
  if (!p) return null;
  const mode = state.mode;
  const errorMsg = state.error;
  const busy = mode === "applying" || mode === "rejecting";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ha-proposal-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="border border-rule"
        style={{
          background: "var(--paper)",
          padding: "1.25rem",
          maxWidth: "640px",
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        <div
          id="ha-proposal-title"
          className="font-display text-2xl mb-2"
          style={{ color: "var(--ink)" }}
        >
          {labelForGapKind(p.kind)}
        </div>
        <p
          className="font-body italic text-[13px] mb-3"
          style={{ color: "var(--marginalia)" }}
        >
          {p.summary}
        </p>
        <pre
          className="font-mono text-[11px] border border-rule p-3 mb-3"
          style={{
            color: "var(--ink)",
            background: "transparent",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {p.yaml}
        </pre>

        {mode === "applied" && (
          <p
            className="font-body italic text-[13px] mb-2"
            style={{ color: "var(--ink)" }}
          >
            Applied. Alfred snapshotted the previous automation; you can
            roll back from the Recent runs ledger.
          </p>
        )}
        {mode === "rejected" && (
          <p
            className="font-body italic text-[13px] mb-2"
            style={{ color: "var(--marginalia)" }}
          >
            Rejected. Alfred won't re-queue this one until you ask.
          </p>
        )}
        {mode === "error" && errorMsg && (
          <p
            className="font-body italic text-[13px] mb-2"
            style={{ color: "var(--brass)" }}
          >
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap gap-3 items-baseline pt-2">
          {(mode === "viewing" || mode === "error") && (
            <>
              <button
                onClick={onApply}
                disabled={busy}
                className="btn-ghost"
              >
                Apply
              </button>
              <button
                onClick={onReject}
                disabled={busy}
                className="btn-link"
              >
                Reject
              </button>
            </>
          )}
          {mode === "applying" && (
            <span
              className="font-mono text-[11px]"
              style={{ color: "var(--marginalia)" }}
            >
              Applying…
            </span>
          )}
          {mode === "rejecting" && (
            <span
              className="font-mono text-[11px]"
              style={{ color: "var(--marginalia)" }}
            >
              Rejecting…
            </span>
          )}
          {mode === "error" && (
            <button onClick={onRetry} className="btn-link">
              Try again
            </button>
          )}
          <button onClick={onClose} disabled={busy} className="btn-link">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function VoiceSurfaceSection() {
  return (
    <div className="border-t border-rule pt-3 space-y-2">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: "var(--marginalia)" }}
      >
        Voice-bridge `self` allowlist
      </div>
      <p
        className="font-body italic text-[12px]"
        style={{ color: "var(--marginalia)" }}
      >
        The four read routes Alfred-the-voice can call against HA without
        per-turn approval. Writes (service calls, automation create /
        update / delete) NEVER appear here — they require a Hermes MCP
        call routed through the principal's approval surface.
      </p>
      {VOICE_SURFACE_TOOLS.map((t) => (
        <div key={t.route} className="font-mono text-[11px]">
          <div style={{ color: "var(--ink)" }}>{t.route}</div>
          <div style={{ color: "var(--marginalia)" }}>{t.what}</div>
        </div>
      ))}
    </div>
  );
}
