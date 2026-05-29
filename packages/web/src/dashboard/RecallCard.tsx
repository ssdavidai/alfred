// RecallCard — /channels surface for Recall.ai meeting bot (#113 PR3).
//
// Lives in its own file (not inline in ChannelsPage.tsx) because the dial
// form + recent-bots table + webhook expander + paste flow add up to a
// substantial chunk of React. The pure derivation lives in
// recallCardCore.ts; this component is the React layer + form plumbing.
//
// Four subviews, driven by deriveRecallCardState's `status`:
//
//   • disabled    — no API key on file. Hero copy + API-key paste form
//                   that two-steps: (1) validateRecallApiKey, (2) on
//                   success, immediately setRecallApiKey to persist the
//                   key into Vaultwarden + the compose .env and trigger
//                   a ctrl-api + alfred-learn restart. The UI shows
//                   "Validating…" then "Saving + restarting…" then
//                   "Connected — bots will dispatch from here on."
//                   (#113 PR3a, closing the gap PR #136 documented as
//                   "persistence pending".)
//   • configured  — dial form (region / bot name / auto-join / cadence
//                   / cost cap / wake word / cost-alert thresholds),
//                   month-to-date usage badge, recent-bots table, Test
//                   Webhook CTA, webhook setup expander, and a new
//                   `key_first6 + [Rotate]` row that re-runs the
//                   validate+persist two-step on a fresh key.
//   • error       — verbatim error string + retry. The form is read-only.
//
// Secrets posture: the API key paste box is type="password", never logged,
// never echoed in toast strings. The configured surface renders
// `api_key_first6` only — exactly six chars + "…" — and never the full
// value. The webhook secret stays first-6 too.

import { useEffect, useMemo, useState } from "react";
import {
  useQuery,
  getRecallChannelStatus,
  updateRecallConfig,
  validateRecallApiKey,
  setRecallApiKey,
  setRecallWebhookSecret,
  testRecallWebhook,
  terminateRecallBot,
} from "wasp/client/operations";
import {
  RECALL_AUTO_JOIN_POLICY_OPTIONS,
  RECALL_CALENDAR_SOURCE_OPTIONS,
  RECALL_DEFAULT_FORM,
  RECALL_LEAVE_AFTER_MINUTES_RANGE,
  RECALL_MONTHLY_HOURS_CAP_RANGE,
  RECALL_REGION_OPTIONS,
  RECALL_RESPOND_MODE_OPTIONS,
  RECALL_WAKE_WORD_RANGE,
  botStatusLabel,
  botDurationMs,
  configToFormValues,
  deriveRecallCardState,
  formatBotDuration,
  formatBotTimestamp,
  formatCostThresholdList,
  formatHours,
  formatRecallWebhookUrl,
  isProbablyValidWakeWord,
  isValidBotName,
  isValidLeaveAfterMinutes,
  isValidMonthlyHoursCap,
  parseCostThresholdList,
  serializeFormPatch,
  truncateBotId,
  type RecallAutoJoinPolicy,
  type RecallCalendarSource,
  type RecallFormValues,
  type RecallRegion,
  type RecallRespondMode,
  type RecallStatus,
} from "./recallCardCore";

// We re-declare a tiny ChannelCard wrapper here mirroring the one
// ChannelsPage.tsx ships — keeping this card a single file with a
// self-contained presentational shell lets the page-level glue stay
// thin (just `<RecallCard />`).

type ChannelStatus = "active" | "available" | "soon" | "starting" | "error";

function ChannelCard({
  name,
  address,
  note,
  status,
  pillOverride,
  children,
}: {
  name: string;
  address: string;
  note: string;
  status: ChannelStatus;
  /** Override the default pill string for this status tone — used by
   *  RecallCard to surface "Unconfigured" / "Webhook not wired" instead
   *  of the generic "Not connected" / "Needs attention" defaults. */
  pillOverride?: string;
  children?: React.ReactNode;
}) {
  const pillColor =
    status === "active" || status === "error"
      ? "var(--brass)"
      : "var(--marginalia)";
  const pillText =
    pillOverride ??
    (status === "active"
      ? "Connected"
      : status === "soon"
        ? "Coming soon"
        : status === "starting"
          ? "Starting"
          : status === "error"
            ? "Needs attention"
            : "Not connected");
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

// ─── the card ────────────────────────────────────────────────────────────

export default function RecallCard() {
  const { data: statusData, refetch } = useQuery(
    getRecallChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as RecallStatus | undefined) ?? null;
  const card = deriveRecallCardState(status);

  // Pill copy upgrade — the four-state pill text Sir asked for. The
  // ChannelCard's defaults render "Not connected" / "Needs attention";
  // we override per-status so the principal sees the actual condition.
  const pillOverride =
    card.status === "disabled"
      ? "Unconfigured"
      : card.status === "partial"
        ? "Webhook not wired"
        : undefined;

  return (
    <ChannelCard
      name="Meeting bot"
      address={card.address}
      note="A second pair of ears for Zoom, Meet, Teams (via Recall.ai)."
      status={card.pillTone}
      pillOverride={pillOverride}
    >
      {card.status === "disabled" && (
        <RecallDisabledPanel onValidated={refetch} />
      )}
      {(card.status === "configured" || card.status === "partial") && (
        <RecallConfiguredPanel
          status={status}
          formInitial={card.formValues}
          monthHours={card.monthHours}
          monthlyHoursCap={card.formValues.monthly_hours_cap}
          costAlertTriggered={card.costAlertTriggered}
          visibleBots={card.visibleBots}
          onSettled={refetch}
        />
      )}
      {card.status === "error" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <button onClick={() => refetch()} className="btn-ghost">
            Re-check
          </button>
        </div>
      )}
    </ChannelCard>
  );
}

// ─── disabled subview — API-key paste / validate + persist (#113 PR3a) ───

/** The two-step state the disabled panel walks through. */
type DisabledPanelPhase =
  | "idle"
  | "validating"
  | "saving"
  | "done"
  | "err_validate"
  | "err_persist";

function RecallDisabledPanel({ onValidated }: { onValidated: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<RecallRegion>(
    RECALL_DEFAULT_FORM.region,
  );
  const [phase, setPhase] = useState<DisabledPanelPhase>("idle");
  const [feedback, setFeedback] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const trimmed = apiKey.trim();
  const busy = phase === "validating" || phase === "saving";
  const canSubmit = trimmed.length > 0 && !busy;

  function reset() {
    setApiKey("");
    setPhase("idle");
    setFeedback(null);
  }

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!canSubmit) return;

    // ── step 1 — validate ────────────────────────────────────────────
    setPhase("validating");
    setFeedback(null);
    let validation: any;
    try {
      validation = await validateRecallApiKey({ api_key: trimmed, region });
    } catch (err: any) {
      setPhase("err_validate");
      setFeedback({
        kind: "err",
        text:
          err?.message ??
          err?.data?.error ??
          "Couldn't reach the validator. Try again, or check that ctrl-api is running.",
      });
      return;
    }
    if (!validation?.ok) {
      // Recall rejected → show its message verbatim + offer a retry.
      setPhase("err_validate");
      setFeedback({
        kind: "err",
        text:
          typeof validation?.reason === "string" && validation.reason
            ? validation.reason
            : "Recall rejected the key.",
      });
      return;
    }

    // ── step 2 — persist (sets vault + .env + restarts) ──────────────
    setPhase("saving");
    try {
      const persisted: any = await setRecallApiKey({
        api_key: trimmed,
        region,
      });
      if (!persisted?.ok) {
        // 200 from the action but {ok:false} envelope — surface verbatim.
        setPhase("err_persist");
        setFeedback({
          kind: "err",
          text:
            typeof persisted?.reason === "string" && persisted.reason
              ? persisted.reason
              : "ctrl-api refused to persist the key.",
        });
        return;
      }
      setPhase("done");
      // We never echo the key — only the first6 fingerprint.
      const first6 =
        typeof persisted?.key_first6 === "string" ? persisted.key_first6 : null;
      const restartedHint =
        Array.isArray(persisted?.restarted) && persisted.restarted.length > 0
          ? ` Restarting ${persisted.restarted.join(" + ")}.`
          : "";
      setFeedback({
        kind: "ok",
        text:
          persisted?.idempotent === true
            ? `Recall key already on file${first6 ? ` (${first6}…)` : ""}. Nothing to do.`
            : `Connected — bots will dispatch from here on${first6 ? ` (${first6}…)` : ""}.${restartedHint}`,
      });
      // Clear the local field. The value is durable on the tenant.
      setApiKey("");
      // Give the restart a moment to land before the next refetch.
      const eta =
        typeof persisted?.eta_seconds === "number" && persisted.eta_seconds > 0
          ? Math.min(persisted.eta_seconds, 30) * 1000
          : 1500;
      window.setTimeout(() => {
        onValidated();
      }, eta);
    } catch (err: any) {
      // ctrl-api rejected the persist — but validate already succeeded,
      // so revert to a state that lets the user retry just the persist
      // step (or paste a different key).
      setPhase("err_persist");
      setFeedback({
        kind: "err",
        text:
          err?.message ??
          err?.data?.error ??
          "Validated, but couldn't save. Try again — the previous key is unchanged.",
      });
    }
  }

  const submitLabel =
    phase === "validating"
      ? "Validating…"
      : phase === "saving"
        ? "Saving + restarting…"
        : phase === "err_validate"
          ? "Try a different key"
          : phase === "err_persist"
            ? "Retry"
            : "Validate + save";

  return (
    <div className="mt-5 space-y-4">
      <p
        className="font-body italic text-[13px]"
        style={{ color: "var(--marginalia)" }}
      >
        Recall.ai sends a bot to your Zoom / Meet / Teams meetings and feeds
        the transcript back here. Paste an API key from{" "}
        <a
          href="https://www.recall.ai/dashboard"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          recall.ai
        </a>{" "}
        to start.
      </p>

      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-2">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Recall API key
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="rcl_… (paste from recall.ai → Settings → API keys)"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label="Recall.ai API key"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
        </div>

        <div className="space-y-2">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Region
          </div>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as RecallRegion)}
            disabled={busy}
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            {RECALL_REGION_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-3 items-baseline">
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-ghost"
          >
            {submitLabel}
          </button>
          {(phase === "err_validate" || phase === "err_persist") && (
            <button type="button" onClick={reset} className="btn-link">
              Reset
            </button>
          )}
          <a
            href="https://www.recall.ai/dashboard"
            target="_blank"
            rel="noreferrer"
            className="btn-ghost"
          >
            Open Recall.ai →
          </a>
        </div>

        {feedback && (
          <p
            className="font-body italic text-[12px]"
            style={{
              color:
                feedback.kind === "ok" ? "var(--marginalia)" : "var(--brass)",
            }}
          >
            {feedback.kind === "ok" ? "✓ " : "✗ "}
            {feedback.text}
          </p>
        )}
      </form>
    </div>
  );
}

// ─── configured subview — full dial form + table + webhook ───────────────

function RecallConfiguredPanel({
  status,
  formInitial,
  monthHours,
  monthlyHoursCap,
  costAlertTriggered,
  visibleBots,
  onSettled,
}: {
  status: RecallStatus | null;
  formInitial: RecallFormValues;
  monthHours: number | null;
  monthlyHoursCap: number;
  costAlertTriggered: boolean;
  visibleBots: ReturnType<typeof deriveRecallCardState>["visibleBots"];
  onSettled: () => void;
}) {
  // Form state — local copy that bind to inputs. Re-seed from
  // formInitial whenever the upstream status changes (e.g. another tab
  // PATCH'd).
  const [form, setForm] = useState<RecallFormValues>(formInitial);
  const [committed, setCommitted] = useState<RecallFormValues>(formInitial);
  const [thresholdsText, setThresholdsText] = useState(() =>
    formatCostThresholdList(formInitial.cost_alert_thresholds),
  );

  // Reset when upstream changes (e.g. cross-tab edit).
  useEffect(() => {
    setForm(formInitial);
    setCommitted(formInitial);
    setThresholdsText(formatCostThresholdList(formInitial.cost_alert_thresholds));
  }, [formInitial]);

  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const [showWebhook, setShowWebhook] = useState(false);
  const [copied, setCopied] = useState(false);

  // Per-bot terminate busy set.
  const [termBusy, setTermBusy] = useState<Set<string>>(new Set());

  // Validation summary — disable Save when anything is off.
  const wakeOk = isProbablyValidWakeWord(form.wake_word);
  const botNameOk = isValidBotName(form.bot_name);
  const monthlyOk = isValidMonthlyHoursCap(form.monthly_hours_cap);
  const leaveOk = isValidLeaveAfterMinutes(form.leave_after_minutes);
  const parsedThresholds = useMemo(
    () => parseCostThresholdList(thresholdsText),
    [thresholdsText],
  );
  const thresholdsOk = parsedThresholds !== null;
  const allValid =
    wakeOk && botNameOk && monthlyOk && leaveOk && thresholdsOk;

  // Diff: what would the PATCH payload be?
  const liveForm: RecallFormValues = useMemo(
    () => ({
      ...form,
      cost_alert_thresholds:
        parsedThresholds ?? form.cost_alert_thresholds,
    }),
    [form, parsedThresholds],
  );
  const patch = useMemo(
    () => serializeFormPatch(liveForm, committed),
    [liveForm, committed],
  );
  const isDirty = Object.keys(patch).length > 0;

  async function save(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!allValid || !isDirty || saveBusy) return;
    setSaveBusy(true);
    setSaveMsg(null);
    try {
      const updated: any = await updateRecallConfig(
        patch as Record<string, unknown>,
      );
      const next = configToFormValues(updated);
      setCommitted(next);
      setForm(next);
      setThresholdsText(formatCostThresholdList(next.cost_alert_thresholds));
      setSaveMsg({ kind: "ok", text: "Saved." });
      onSettled();
    } catch (err: any) {
      const reason =
        err?.message ?? err?.data?.error ?? "Couldn't save the dials.";
      setSaveMsg({ kind: "err", text: reason });
    } finally {
      setSaveBusy(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  }

  async function fireTest() {
    if (testBusy) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await testRecallWebhook({});
      if (r?.ok) {
        const lat =
          typeof r?.latency_ms === "number" ? `${r.latency_ms} ms` : "ok";
        setTestMsg({
          kind: "ok",
          text: `Round-trip ${lat} · webhook target accepted the synthetic delivery.`,
        });
      } else {
        const reason =
          (typeof r?.sample_response === "string" && r.sample_response) ||
          (typeof r?.error === "string" && r.error) ||
          (typeof r?.status === "number" ? `HTTP ${r.status}` : "refused");
        setTestMsg({ kind: "err", text: reason });
      }
      onSettled();
    } catch (err: any) {
      setTestMsg({
        kind: "err",
        text:
          err?.message ?? err?.data?.error ?? "Couldn't reach the webhook target.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  async function terminate(botId: string) {
    if (termBusy.has(botId)) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Terminate bot ${truncateBotId(botId)}?`)
    ) {
      return;
    }
    setTermBusy((s) => new Set(s).add(botId));
    try {
      await terminateRecallBot({ bot_id: botId });
      onSettled();
    } catch (err) {
      console.error("recall terminate failed", err);
    } finally {
      setTermBusy((s) => {
        const next = new Set(s);
        next.delete(botId);
        return next;
      });
    }
  }

  // Webhook URL: synthesise from the server when present; fall back to
  // window.location.origin so the operator can still copy something
  // meaningful before PR3a surfaces it explicitly on /status.
  const origin =
    (typeof status?.webhook_url === "string" && status.webhook_url) ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const webhookUrl = useMemo(() => formatRecallWebhookUrl(origin), [origin]);
  const secretFirst6 =
    typeof status?.config?.webhook_secret_first6 === "string"
      ? status.config.webhook_secret_first6
      : typeof status?.webhook_secret_first6 === "string"
        ? status.webhook_secret_first6
        : null;
  const webhookSecretSet =
    typeof status?.config?.webhook_secret_set === "boolean"
      ? status.config.webhook_secret_set
      : typeof status?.webhook_secret_set === "boolean"
        ? status.webhook_secret_set
        : null;
  // RECALL_API_KEY fingerprint (PR3a) — surfaced on the rotation row.
  const keyFirst6 =
    typeof status?.config?.api_key_first6 === "string"
      ? status.config.api_key_first6
      : null;

  function copyWebhook() {
    if (!webhookUrl) return;
    navigator.clipboard?.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // ─── rotate state — re-paste a new key, runs the same validate+persist
  //     two-step the disabled panel does. Lives in the configured panel
  //     so the principal never has to disconnect to rotate.
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateKey, setRotateKey] = useState("");
  const [rotatePhase, setRotatePhase] = useState<
    "idle" | "validating" | "saving" | "done" | "err"
  >("idle");
  const [rotateMsg, setRotateMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  const rotateBusy = rotatePhase === "validating" || rotatePhase === "saving";

  // ─── webhook-secret paste state ─────────────────────────────────────
  //
  // Mirrors the api-key rotate flow: a password input + Save button
  // that calls setRecallWebhookSecret. Lives in the configured panel so
  // both the "partial" (api_key set, webhook not wired — input shown
  // open by default) and "configured" (both wired — input behind a
  // Rotate affordance) states share one code path.
  const [wsOpen, setWsOpen] = useState<boolean>(webhookSecretSet === false);
  const [wsValue, setWsValue] = useState("");
  const [wsPhase, setWsPhase] = useState<
    "idle" | "saving" | "done" | "err"
  >("idle");
  const [wsMsg, setWsMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  const wsBusy = wsPhase === "saving";

  // Re-open the input automatically if the upstream flips to "not set"
  // (e.g. after a tenant reset). Closing it requires an explicit
  // Cancel.
  useEffect(() => {
    if (webhookSecretSet === false) setWsOpen(true);
  }, [webhookSecretSet]);

  async function saveWebhookSecret(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const trimmed = wsValue.trim();
    if (!trimmed || wsBusy) return;
    setWsPhase("saving");
    setWsMsg(null);
    try {
      const p: any = await setRecallWebhookSecret({
        webhook_secret: trimmed,
      });
      if (!p?.ok) {
        setWsPhase("err");
        setWsMsg({
          kind: "err",
          text:
            typeof p?.reason === "string" && p.reason
              ? p.reason
              : "ctrl-api refused to persist the webhook secret.",
        });
        return;
      }
      setWsPhase("done");
      const first6 =
        typeof p?.secret_first6 === "string" ? p.secret_first6 : null;
      setWsMsg({
        kind: "ok",
        text:
          p?.idempotent === true
            ? `Same secret on file (${first6 ?? "?"}…). Nothing to do.`
            : `Webhook wired (${first6 ?? "saved"}…). Restarting ctrl-api.`,
      });
      setWsValue("");
      const eta =
        typeof p?.eta_seconds === "number" && p.eta_seconds > 0
          ? Math.min(p.eta_seconds, 30) * 1000
          : 1500;
      window.setTimeout(() => {
        setWsOpen(false);
        setWsMsg(null);
        setWsPhase("idle");
        onSettled();
      }, eta);
    } catch (err: any) {
      setWsPhase("err");
      setWsMsg({
        kind: "err",
        text:
          err?.message ??
          err?.data?.error ??
          "Couldn't reach ctrl-api. Try again.",
      });
    }
  }

  async function rotate(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const trimmed = rotateKey.trim();
    if (!trimmed || rotateBusy) return;
    setRotatePhase("validating");
    setRotateMsg(null);
    try {
      const v: any = await validateRecallApiKey({
        api_key: trimmed,
        region: form.region,
      });
      if (!v?.ok) {
        setRotatePhase("err");
        setRotateMsg({
          kind: "err",
          text:
            typeof v?.reason === "string" && v.reason
              ? v.reason
              : "Recall rejected the new key.",
        });
        return;
      }
      setRotatePhase("saving");
      const p: any = await setRecallApiKey({
        api_key: trimmed,
        region: form.region,
      });
      if (!p?.ok) {
        setRotatePhase("err");
        setRotateMsg({
          kind: "err",
          text:
            typeof p?.reason === "string" && p.reason
              ? p.reason
              : "Validated, but couldn't save the new key.",
        });
        return;
      }
      setRotatePhase("done");
      const first6 = typeof p?.key_first6 === "string" ? p.key_first6 : null;
      setRotateMsg({
        kind: "ok",
        text:
          p?.idempotent === true
            ? `Same key — nothing to rotate (${first6 ?? "?"}…).`
            : `Rotated to ${first6 ?? "new key"}…. Restarting.`,
      });
      setRotateKey("");
      const eta =
        typeof p?.eta_seconds === "number" && p.eta_seconds > 0
          ? Math.min(p.eta_seconds, 30) * 1000
          : 1500;
      window.setTimeout(() => {
        setRotateOpen(false);
        setRotateMsg(null);
        setRotatePhase("idle");
        onSettled();
      }, eta);
    } catch (err: any) {
      setRotatePhase("err");
      setRotateMsg({
        kind: "err",
        text:
          err?.message ??
          err?.data?.error ??
          "Couldn't reach the validator. Try again.",
      });
    }
  }

  return (
    <div className="mt-5 space-y-6">
      {/* Usage strip */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 items-baseline">
        <span
          className="font-mono text-[12px]"
          style={{ color: "var(--ink)" }}
        >
          Month-to-date: {monthHours !== null ? formatHours(monthHours) : "—"} /{" "}
          {monthlyHoursCap}h
        </span>
        {costAlertTriggered && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
            style={{ color: "var(--brass)" }}
          >
            Cost alert · threshold reached
          </span>
        )}
      </div>

      {/* API key row — never echoes the full value. (#113 PR3a) */}
      <div className="border border-rule p-3 space-y-2">
        <div className="flex flex-wrap items-baseline gap-3 justify-between">
          <div className="flex items-baseline gap-3">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Recall API key
            </div>
            <code
              className="font-mono text-[12px]"
              style={{ color: "var(--ink)" }}
            >
              {keyFirst6 ? `${keyFirst6}…` : "—"}
            </code>
          </div>
          {!rotateOpen && (
            <button
              type="button"
              onClick={() => {
                setRotateOpen(true);
                setRotateMsg(null);
                setRotatePhase("idle");
              }}
              disabled={rotateBusy}
              className="btn-ghost"
            >
              Rotate
            </button>
          )}
        </div>
        {rotateOpen && (
          <form onSubmit={rotate} className="space-y-2 pt-2">
            <input
              type="password"
              value={rotateKey}
              onChange={(e) => setRotateKey(e.target.value)}
              placeholder="Paste a new Recall API key"
              autoComplete="off"
              spellCheck={false}
              disabled={rotateBusy}
              aria-label="Recall.ai API key"
              className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            <div className="flex gap-3 items-baseline">
              <button
                type="submit"
                disabled={rotateBusy || rotateKey.trim().length === 0}
                className="btn-ghost"
              >
                {rotatePhase === "validating"
                  ? "Validating…"
                  : rotatePhase === "saving"
                    ? "Saving + restarting…"
                    : "Validate + save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRotateOpen(false);
                  setRotateKey("");
                  setRotateMsg(null);
                  setRotatePhase("idle");
                }}
                disabled={rotateBusy}
                className="btn-link"
              >
                Cancel
              </button>
            </div>
            {rotateMsg && (
              <p
                className="font-body italic text-[12px]"
                style={{
                  color:
                    rotateMsg.kind === "ok"
                      ? "var(--marginalia)"
                      : "var(--brass)",
                }}
              >
                {rotateMsg.kind === "ok" ? "✓ " : "✗ "}
                {rotateMsg.text}
              </p>
            )}
          </form>
        )}
      </div>

      {/* Webhook signing secret row — sibling to the API-key row. Always
          renders so the operator never has to dig into an expander to
          find where to paste the signing secret. When the secret IS on
          file we collapse to first6+Rotate; when it's NOT, the input is
          open by default (driven by webhookSecretSet === false). */}
      <div
        className="border border-rule p-3 space-y-2"
        style={
          webhookSecretSet === false
            ? { borderColor: "var(--brass)" }
            : undefined
        }
      >
        <div className="flex flex-wrap items-baseline gap-3 justify-between">
          <div className="flex items-baseline gap-3 flex-wrap">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Webhook signing secret
            </div>
            <code
              className="font-mono text-[12px]"
              style={{ color: "var(--ink)" }}
            >
              {secretFirst6 ? `${secretFirst6}…` : "—"}
            </code>
            {webhookSecretSet === false && (
              <span
                className="font-body italic text-[12px]"
                style={{ color: "var(--brass)" }}
              >
                Required — inbound deliveries 401 until set.
              </span>
            )}
          </div>
          {!wsOpen && (
            <button
              type="button"
              onClick={() => {
                setWsOpen(true);
                setWsMsg(null);
                setWsPhase("idle");
              }}
              disabled={wsBusy}
              className="btn-ghost"
            >
              {webhookSecretSet === true ? "Rotate" : "Paste secret"}
            </button>
          )}
        </div>
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          From recall.ai → Webhooks → Signing secret. Starts with{" "}
          <code>whsec_</code>.
        </p>
        {wsOpen && (
          <form onSubmit={saveWebhookSecret} className="space-y-2 pt-2">
            <input
              type="password"
              value={wsValue}
              onChange={(e) => setWsValue(e.target.value)}
              placeholder="whsec_…"
              autoComplete="off"
              spellCheck={false}
              disabled={wsBusy}
              aria-label="Recall.ai webhook signing secret"
              className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            <div className="flex gap-3 items-baseline">
              <button
                type="submit"
                disabled={wsBusy || wsValue.trim().length === 0}
                className="btn-ghost"
              >
                {wsPhase === "saving"
                  ? "Saving + restarting…"
                  : webhookSecretSet === true
                    ? "Rotate secret"
                    : "Save secret"}
              </button>
              {webhookSecretSet === true && (
                <button
                  type="button"
                  onClick={() => {
                    setWsOpen(false);
                    setWsValue("");
                    setWsMsg(null);
                    setWsPhase("idle");
                  }}
                  disabled={wsBusy}
                  className="btn-link"
                >
                  Cancel
                </button>
              )}
            </div>
            {wsMsg && (
              <p
                className="font-body italic text-[12px]"
                style={{
                  color:
                    wsMsg.kind === "ok"
                      ? "var(--marginalia)"
                      : "var(--brass)",
                }}
              >
                {wsMsg.kind === "ok" ? "✓ " : "✗ "}
                {wsMsg.text}
              </p>
            )}
          </form>
        )}
      </div>

      {/* Dial form */}
      <form onSubmit={save} className="space-y-4">
        <Row label="Region">
          <select
            value={form.region}
            onChange={(e) =>
              setForm({ ...form, region: e.target.value as RecallRegion })
            }
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            {RECALL_REGION_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Bot name">
          <input
            type="text"
            value={form.bot_name}
            onChange={(e) => setForm({ ...form, bot_name: e.target.value })}
            maxLength={200}
            className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          {!botNameOk && <Hint>Required, ≤200 chars.</Hint>}
        </Row>

        <Row label="Announces on join">
          <label className="font-mono text-[12px] inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.announces_on_join}
              onChange={(e) =>
                setForm({ ...form, announces_on_join: e.target.checked })
              }
            />
            <span>
              {form.announces_on_join ? "Yes" : "No"}
            </span>
          </label>
        </Row>

        <Row label="Auto-join policy">
          <select
            value={form.auto_join_policy}
            onChange={(e) =>
              setForm({
                ...form,
                auto_join_policy: e.target.value as RecallAutoJoinPolicy,
              })
            }
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            {RECALL_AUTO_JOIN_POLICY_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Calendar source">
          <select
            value={form.calendar_source}
            onChange={(e) =>
              setForm({
                ...form,
                calendar_source: e.target.value as RecallCalendarSource,
              })
            }
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            {RECALL_CALENDAR_SOURCE_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Monthly hours cap">
          <input
            type="number"
            min={RECALL_MONTHLY_HOURS_CAP_RANGE.min}
            max={RECALL_MONTHLY_HOURS_CAP_RANGE.max}
            value={form.monthly_hours_cap}
            onChange={(e) =>
              setForm({
                ...form,
                monthly_hours_cap: Number.parseInt(e.target.value, 10) || 0,
              })
            }
            className="w-24 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          {!monthlyOk && (
            <Hint>
              {RECALL_MONTHLY_HOURS_CAP_RANGE.min}–
              {RECALL_MONTHLY_HOURS_CAP_RANGE.max} integer.
            </Hint>
          )}
        </Row>

        <Row label="Leave after minutes">
          <input
            type="number"
            min={RECALL_LEAVE_AFTER_MINUTES_RANGE.min}
            max={RECALL_LEAVE_AFTER_MINUTES_RANGE.max}
            value={form.leave_after_minutes}
            onChange={(e) =>
              setForm({
                ...form,
                leave_after_minutes:
                  Number.parseInt(e.target.value, 10) || 0,
              })
            }
            className="w-24 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          {!leaveOk && (
            <Hint>
              {RECALL_LEAVE_AFTER_MINUTES_RANGE.min}–
              {RECALL_LEAVE_AFTER_MINUTES_RANGE.max} integer.
            </Hint>
          )}
        </Row>

        <Row label="Respond mode">
          <select
            value={form.respond_mode}
            onChange={(e) =>
              setForm({
                ...form,
                respond_mode: e.target.value as RecallRespondMode,
              })
            }
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            {RECALL_RESPOND_MODE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Wake word">
          <input
            type="text"
            value={form.wake_word}
            onChange={(e) => setForm({ ...form, wake_word: e.target.value })}
            maxLength={RECALL_WAKE_WORD_RANGE.max}
            className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          {!wakeOk && (
            <Hint>
              1–{RECALL_WAKE_WORD_RANGE.max} chars, no control characters.
            </Hint>
          )}
        </Row>

        <Row label="Cost-alert thresholds (%)">
          <input
            type="text"
            value={thresholdsText}
            onChange={(e) => setThresholdsText(e.target.value)}
            placeholder="80, 100"
            className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          {!thresholdsOk && (
            <Hint>Comma- or space-separated integers in 1–200.</Hint>
          )}
        </Row>

        <div className="flex gap-3 items-baseline pt-1">
          <button
            type="submit"
            disabled={!allValid || !isDirty || saveBusy}
            className="btn-ghost"
          >
            {saveBusy ? "Saving…" : isDirty ? "Save dials" : "Saved"}
          </button>
          <button
            type="button"
            onClick={fireTest}
            disabled={testBusy}
            className="btn-ghost"
          >
            {testBusy ? "…" : "Send test webhook"}
          </button>
        </div>

        {saveMsg && (
          <p
            className="font-body italic text-[12px]"
            style={{
              color:
                saveMsg.kind === "ok" ? "var(--marginalia)" : "var(--brass)",
            }}
          >
            {saveMsg.kind === "ok" ? "✓ " : "✗ "}
            {saveMsg.text}
          </p>
        )}
        {testMsg && (
          <p
            className="font-body italic text-[12px]"
            style={{
              color:
                testMsg.kind === "ok" ? "var(--marginalia)" : "var(--brass)",
            }}
          >
            {testMsg.kind === "ok" ? "✓ " : "✗ "}
            {testMsg.text}
          </p>
        )}
      </form>

      {/* Recent (active) bots table */}
      {visibleBots.length > 0 && (
        <div className="space-y-2">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Active bots
          </div>
          <div
            className="border border-rule overflow-x-auto"
            style={{ maxHeight: "20rem" }}
          >
            <table className="w-full text-[12px] font-mono">
              <thead>
                <tr
                  style={{ color: "var(--marginalia)" }}
                  className="text-left"
                >
                  <th className="p-2">Status</th>
                  <th className="p-2">Calendar event</th>
                  <th className="p-2">Joined at</th>
                  <th className="p-2">Duration</th>
                  <th className="p-2">Transcript</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {visibleBots.map((b) => (
                  <tr key={b.id} className="border-t border-rule">
                    <td className="p-2">{botStatusLabel(b.status)}</td>
                    <td className="p-2">{b.calendar_event_id ?? "—"}</td>
                    <td className="p-2">{formatBotTimestamp(b.joined_at)}</td>
                    <td className="p-2">
                      {formatBotDuration(botDurationMs(b))}
                    </td>
                    <td className="p-2">
                      {b.transcript_url ? (
                        <a
                          href={b.transcript_url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          open
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => terminate(b.id)}
                        disabled={termBusy.has(b.id)}
                        className="btn-link"
                      >
                        {termBusy.has(b.id) ? "…" : "Terminate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Webhook setup expander */}
      <div className="border-t border-rule pt-3">
        <button
          type="button"
          onClick={() => setShowWebhook((s) => !s)}
          className="btn-link"
        >
          {showWebhook ? "Hide" : "Show"} webhook setup
        </button>
        {showWebhook && (
          <div className="mt-3 space-y-3">
            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Webhook URL (paste into Recall.ai → Webhooks)
              </div>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 font-mono text-[11px] border border-rule p-2 truncate"
                  style={{ color: "var(--ink)" }}
                >
                  {webhookUrl || "—"}
                </code>
                <button
                  type="button"
                  onClick={copyWebhook}
                  disabled={!webhookUrl}
                  className="btn-ghost"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Subscribe to these events
              </div>
              <ul
                className="font-mono text-[12px] list-disc ml-5 space-y-1"
                style={{ color: "var(--ink)" }}
              >
                <li>
                  <code>bot.status_change</code> — lifecycle transitions
                  (joining → in-meeting → leaving → done).
                </li>
                <li>
                  <code>bot.done</code> — bot left the meeting cleanly.
                </li>
                <li>
                  <code>bot.fatal</code> — bot failed to join or crashed
                  mid-call.
                </li>
                <li>
                  <code>bot.recording_done</code> — recording artefact is
                  ready; ctrl-api persists the transcript URL onto the
                  bot row.
                </li>
              </ul>
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                <code>bot.transcription.message</code> is deferred — only
                subscribe to it once in-meeting voice (PR #154) ships.
              </p>
            </div>

            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Signing secret on file (first 6)
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <code
                  className="font-mono text-[12px] border border-rule p-2"
                  style={{ color: "var(--ink)" }}
                >
                  {secretFirst6 ? `${secretFirst6}…` : "—"}
                </code>
                <span
                  className="font-body italic text-[12px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Pasted in the &ldquo;Webhook signing secret&rdquo;
                  block above.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── tiny presentational helpers ─────────────────────────────────────────

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] w-40"
        style={{ color: "var(--marginalia)" }}
      >
        {label}
      </div>
      <div className="flex-1 flex flex-wrap items-baseline gap-2 min-w-[12rem]">
        {children}
      </div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-body italic text-[12px]"
      style={{ color: "var(--brass)" }}
    >
      {children}
    </span>
  );
}
