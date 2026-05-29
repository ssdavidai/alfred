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
//                   that round-trips via validateRecallApiKey (NO
//                   persistence — that ships in PR3a). On a successful
//                   round-trip we surface a "validated, persistence
//                   pending" note and the principal can either tap
//                   refresh or move on.
//   • configured  — dial form (region / bot name / auto-join / cadence
//                   / cost cap / wake word / cost-alert thresholds),
//                   month-to-date usage badge, recent-bots table, Test
//                   Webhook CTA, webhook setup expander.
//   • error       — verbatim error string + retry. The form is read-only.
//
// Secrets posture: the API key paste box is type="password", never logged,
// never echoed in toast strings. The webhook secret is surfaced as first-6
// only; the full secret stays in /opt/alfred/.env.

import { useEffect, useMemo, useState } from "react";
import {
  useQuery,
  getRecallChannelStatus,
  updateRecallConfig,
  validateRecallApiKey,
  testRecallWebhook,
  terminateRecallBot,
  getRecallBotTranscript,
  muteRecallBot,
  unmuteRecallBot,
  recallBotSpeak,
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

// ─── the card ────────────────────────────────────────────────────────────

export default function RecallCard() {
  const { data: statusData, refetch } = useQuery(
    getRecallChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as RecallStatus | undefined) ?? null;
  const card = deriveRecallCardState(status);

  return (
    <ChannelCard
      name="Meeting bot"
      address={card.address}
      note="A second pair of ears for Zoom, Meet, Teams (via Recall.ai)."
      status={card.pillTone}
    >
      {card.status === "disabled" && (
        <RecallDisabledPanel onValidated={refetch} />
      )}
      {card.status === "configured" && (
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

// ─── disabled subview — API-key paste / validate ─────────────────────────

function RecallDisabledPanel({ onValidated }: { onValidated: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<RecallRegion>(
    RECALL_DEFAULT_FORM.region,
  );
  const [validating, setValidating] = useState(false);
  const [feedback, setFeedback] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const trimmed = apiKey.trim();
  const canSubmit = trimmed.length > 0 && !validating;

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!canSubmit) return;
    setValidating(true);
    setFeedback(null);
    try {
      const result: any = await validateRecallApiKey({
        api_key: trimmed,
        region,
      });
      if (result?.ok) {
        // NEVER echo the key. Just confirm.
        const knownBots =
          typeof result?.account?.bots_known === "number"
            ? ` (${result.account.bots_known} bots on file)`
            : "";
        setFeedback({
          kind: "ok",
          text:
            `Recall accepted the key${knownBots}. ` +
            "Persistence ships in #113 PR3a — paste it into /opt/alfred/.env " +
            "as RECALL_API_KEY for now, then reload this card.",
        });
        // Clear the local field — the value is in the user's clipboard
        // already if they copied it from Recall, and there is no
        // server-side persistence yet.
        setApiKey("");
        onValidated();
      } else {
        const reason =
          typeof result?.reason === "string" && result.reason
            ? result.reason
            : "Recall rejected the key.";
        setFeedback({ kind: "err", text: reason });
      }
    } catch (err: any) {
      const message =
        err?.message ?? err?.data?.error ?? "Couldn't reach the validator.";
      setFeedback({ kind: "err", text: message });
    } finally {
      setValidating(false);
    }
  }

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
            placeholder="Paste from recall.ai → Settings → API keys"
            autoComplete="off"
            spellCheck={false}
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
            {validating ? "Validating…" : "Validate key"}
          </button>
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
    typeof status?.webhook_secret_first6 === "string"
      ? status.webhook_secret_first6
      : null;

  function copyWebhook() {
    if (!webhookUrl) return;
    navigator.clipboard?.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

      {/* Live bots — PR5 — Alfred-in-meeting two-way voice */}
      {visibleBots.filter((b) => b.status === "in_meeting").length > 0 && (
        <div className="space-y-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Live bots — Alfred in the meeting
          </div>
          <div className="space-y-3">
            {visibleBots
              .filter((b) => b.status === "in_meeting")
              .map((b) => (
                <LiveBotRow key={b.id} botId={b.id} onSettled={onSettled} />
              ))}
          </div>
        </div>
      )}

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
                Webhook secret (first 6)
              </div>
              <div className="flex items-center gap-3">
                <code
                  className="font-mono text-[12px] border border-rule p-2"
                  style={{ color: "var(--ink)" }}
                >
                  {secretFirst6 ? `${secretFirst6}…` : "—"}
                </code>
                <button
                  type="button"
                  disabled
                  title="Secret rotation lands in #113 PR3a; for now the secret is fixed at tenant init."
                  className="btn-ghost opacity-50 cursor-not-allowed"
                >
                  Rotate secret
                </button>
                <span
                  className="font-body italic text-[12px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  coming soon
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

// ─── live bot row — PR5 ──────────────────────────────────────────────────
//
// One row per in-meeting Recall bot, surfacing:
//   * the live transcript (polled JSON companion to the SSE stream),
//   * the "Mute Alfred" / "Unmute Alfred" toggle,
//   * a "Speak now" textarea + button,
//   * a wake-word-triggers counter.

interface TranscriptEvent {
  id: number;
  kind: "partial" | "final" | "response" | "wake_word_hit";
  speaker: string | null;
  text: string;
  ts_ms: number;
  meeting_ms: number | null;
}

interface TranscriptPayload {
  bot_id: string;
  wake_word_triggers: number;
  muted: boolean;
  events: TranscriptEvent[];
  unavailable?: boolean;
}

function LiveBotRow({
  botId,
  onSettled,
}: {
  botId: string;
  onSettled: () => void;
}) {
  // Poll the transcript companion JSON every 2 seconds. The poll
  // cadence is conservative on purpose — heavy meeting traffic gives
  // 5+ transcript fragments per second on the SSE channel, but the
  // dashboard view only needs second-resolution to feel live.
  const { data: tx, refetch } = useQuery(
    getRecallBotTranscript,
    { bot_id: botId },
    { refetchInterval: 2000, retry: false },
  );
  const payload = (tx as TranscriptPayload | undefined) ?? null;
  const events = payload?.events ?? [];
  const muted = payload?.muted ?? false;
  const triggers = payload?.wake_word_triggers ?? 0;

  const [muteBusy, setMuteBusy] = useState(false);
  const [speakBusy, setSpeakBusy] = useState(false);
  const [speakText, setSpeakText] = useState("");
  const [speakMsg, setSpeakMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  async function toggleMute() {
    if (muteBusy) return;
    setMuteBusy(true);
    try {
      if (muted) await unmuteRecallBot({ bot_id: botId });
      else await muteRecallBot({ bot_id: botId });
      refetch();
      onSettled();
    } catch (err) {
      console.error("recall mute toggle failed", err);
    } finally {
      setMuteBusy(false);
    }
  }

  async function speakNow(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const text = speakText.trim();
    if (!text || speakBusy) return;
    setSpeakBusy(true);
    setSpeakMsg(null);
    try {
      await recallBotSpeak({ bot_id: botId, text });
      setSpeakText("");
      setSpeakMsg({ kind: "ok", text: "Alfred is speaking." });
      refetch();
    } catch (err: any) {
      setSpeakMsg({
        kind: "err",
        text: err?.message ?? err?.data?.error ?? "Couldn't send the line.",
      });
    } finally {
      setSpeakBusy(false);
      setTimeout(() => setSpeakMsg(null), 4000);
    }
  }

  // Recent fragments — show the last 10 in chronological order.
  const recent = events.slice(-10);

  return (
    <div className="border border-rule p-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <code
          className="font-mono text-[11px]"
          style={{ color: "var(--ink)" }}
        >
          {truncateBotId(botId)}
        </code>
        <div className="flex gap-3 items-baseline">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Wake triggers · {triggers}
          </span>
          <button
            type="button"
            onClick={toggleMute}
            disabled={muteBusy}
            className="btn-link"
            aria-pressed={muted}
          >
            {muteBusy ? "…" : muted ? "Unmute Alfred" : "Mute Alfred"}
          </button>
        </div>
      </div>

      {/* Live transcript */}
      <div
        className="font-mono text-[11px] space-y-1 max-h-40 overflow-y-auto"
        style={{ color: "var(--ink)" }}
      >
        {payload?.unavailable && (
          <div
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            Live transcript is not yet available for this tenant.
          </div>
        )}
        {recent.length === 0 && !payload?.unavailable && (
          <div
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            Listening…
          </div>
        )}
        {recent.map((ev) => (
          <div key={ev.id} className="flex gap-2">
            <span
              className="uppercase tracking-[0.18em] text-[9px]"
              style={{
                color:
                  ev.kind === "wake_word_hit"
                    ? "var(--brass)"
                    : ev.kind === "response"
                      ? "var(--marginalia)"
                      : "var(--ink)",
                minWidth: "6rem",
              }}
            >
              {ev.kind === "response"
                ? "Alfred"
                : ev.kind === "wake_word_hit"
                  ? "WAKE"
                  : ev.speaker || "—"}
            </span>
            <span className="flex-1">{ev.text}</span>
          </div>
        ))}
      </div>

      {/* Speak now */}
      <form onSubmit={speakNow} className="space-y-2">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Speak as Alfred
        </div>
        <textarea
          value={speakText}
          onChange={(e) => setSpeakText(e.target.value)}
          maxLength={1000}
          placeholder='e.g. "Pardon me — Sir asked me to note we\'re running long."'
          rows={2}
          className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
        />
        <div className="flex gap-3 items-baseline">
          <button
            type="submit"
            disabled={speakBusy || speakText.trim().length === 0}
            className="btn-ghost"
          >
            {speakBusy ? "Speaking…" : "Speak now"}
          </button>
          {speakMsg && (
            <span
              className="font-body italic text-[12px]"
              style={{
                color:
                  speakMsg.kind === "ok"
                    ? "var(--marginalia)"
                    : "var(--brass)",
              }}
            >
              {speakMsg.kind === "ok" ? "✓ " : "✗ "}
              {speakMsg.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
