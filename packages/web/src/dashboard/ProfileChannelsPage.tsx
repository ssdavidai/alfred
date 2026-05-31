// ProfileChannelsPage — per-profile FULL channels surface (#120 Lane V).
//
// Sir's clarification: "I want to set email, sms, phone, telegram, slack, etc
// PER PROFILE." This page renders every profile-aware channel for a single
// profile slug, side-by-side with a clear back-link to the main /channels
// page.
//
// What this page CAN configure per profile (Lane IV + Lane V + Lane Vb2 on ctrl-api):
//
//   * Telegram   — token (PUT), status (GET), revoke chat
//   * Slack      — bot/app tokens (PUT), status (GET)
//   * SMS        — Twilio creds (PUT), status (GET)
//   * Paperclip  — API key (POST), status (GET)
//   * Email      — Lane Vb2; provision (POST), status (GET), disconnect
//                  (DELETE), send-test (POST). AgentMail's API is called
//                  on the tenant: a fresh inbox is minted per profile + a
//                  channel binding (email, <address>) → <slug> is written
//                  so inbound mail routes to the right profile.
//
// What this page CANNOT configure per profile and why (honest partial):
//
//   * Voice (voice-bridge sibling) — one Twilio number + one OPENAI key per
//     VM. Voice-bridge isn't a Hermes profile; it's a separate compose
//     service. Configure on /channels.
//   * OMI — one device, one Groq key consumed by alfred-learn (not Hermes).
//     The Vault item is global. Configure on /channels.
//   * Home Assistant — one household, one HA URL + LLAT. Single-instance
//     integration. Configure on /channels.
//   * Recall.ai — one calendar bot account. Single-instance integration.
//     Configure on /channels.
//   * Tailscale / Terminal — instance-level (single VM ↔ single tailnet ↔
//     single SSH host). NOT a channel in the per-profile sense.
//
// The back-compat link reads "Main profile's channels" so the relationship
// to /channels is explicit.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useQuery,
  getAgentProfile,
  getProfileChannelStatuses,
  setProfileChannelToken,
  clearProfileChannelToken,
  getProfileEmailStatus,
  provisionProfileEmailInbox,
  clearProfileEmailInbox,
  sendProfileEmailTest,
} from "wasp/client/operations";
import { Frame, PageHeading } from "../client/components/ab/Frame";
import { ChannelCard, type ChannelStatus } from "./ChannelsPage";
import {
  deriveTelegramCardState,
  isProbablyValidBotToken,
  type TelegramStatus,
} from "./telegramCardCore";
import {
  deriveSlackCardState,
  type SlackStatus,
} from "./slackCardCore";
import {
  deriveSmsCardState,
  type SmsStatus,
} from "./smsCardCore";
import {
  derivePaperclipCardState,
  type PaperclipStatus,
} from "./paperclipCardCore";

interface ProfileRow {
  slug: string;
  label: string;
  description: string | null;
  model: string;
  api_server_port: number;
  status: "pending" | "running" | "stopped" | "archived";
  is_user_facing: boolean;
  is_reserved: boolean;
  archived_at: number | null;
}

interface ChannelStatusEntry<TStatus = unknown> {
  kind: "telegram" | "slack" | "sms" | "paperclip";
  ok: boolean;
  status: TStatus | null;
  error?: string;
}

interface ProfileChannelStatuses {
  slug: string;
  channels: ChannelStatusEntry[];
}

// --------------------------------------------------------------------------
// Restart-scope warning. Lane V's ctrl-api surfaces `restart_scope` on every
// token write: 'per-profile' is the happy path; 'compose-restart' is a wider
// fallback the principal should know about; 'noop' = the restart couldn't be
// sent at all (the new env will apply on the next supervisor tick). Show a
// muted hint after a write if the scope is anything but 'per-profile'.
// --------------------------------------------------------------------------
function RestartScopeWarning({ scope, warning }: { scope?: string; warning?: string | null }) {
  if (!scope) return null;
  // Lane V's honest semantics: even on the "per-profile" happy path, the
  // gateway doesn't bounce immediately (the SIGUSR1 broadcast would knock
  // main offline too — tini's -g mode), so we surface the deferred-restart
  // warning the route attached. compose-restart is a wider blast; noop is
  // even wider deferral.
  const msg =
    scope === "compose-restart"
      ? "Heads up: the whole Hermes container restarted (per-profile signal couldn't be sent). All profiles bounced briefly."
      : warning ?? null;
  if (!msg) return null;
  return (
    <p
      className="font-body italic text-[12px] mt-2"
      style={{ color: "var(--marginalia)" }}
    >
      {msg}
    </p>
  );
}

// --------------------------------------------------------------------------
// TelegramSection. Mirror of the /channels TelegramCard's setup form but
// thread the profile slug through every write.
// --------------------------------------------------------------------------
function ProfileTelegramSection({
  slug,
  entry,
  refetch,
}: {
  slug: string;
  entry: ChannelStatusEntry<TelegramStatus> | null;
  refetch: () => void;
}) {
  const card = deriveTelegramCardState({
    status: entry?.ok ? (entry.status as TelegramStatus | null) : null,
  });
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);

  const trimmed = token.trim();
  const valid = isProbablyValidBotToken(trimmed);

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await setProfileChannelToken({
        slug,
        channel_kind: "telegram",
        payload: { token: trimmed },
      });
      setLastResp(resp);
      setToken("");
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? e?.data?.error ?? "Couldn't save the token.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await clearProfileChannelToken({
        slug,
        channel_kind: "telegram",
      });
      setLastResp(resp);
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't disconnect the bot.");
    } finally {
      setBusy(false);
    }
  }

  const address =
    card.state === "configured_running"
      ? card.heading
      : card.state === "configured_starting"
        ? "Restarting…"
        : card.state === "error"
          ? "Token rejected"
          : "Not yet configured";

  return (
    <ChannelCard
      name="Telegram"
      address={address}
      note={`Bot token scoped to '${slug}'.`}
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Bot token · for {slug}
          </div>
          <div className="flex gap-2 items-baseline">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:ABC-…"
              className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            <button
              type="button"
              onClick={() => setShowToken((s) => !s)}
              className="btn-link"
            >
              {showToken ? "Hide" : "Show"}
            </button>
            <button
              onClick={save}
              disabled={busy || !valid}
              className="btn-ghost"
            >
              {busy ? "…" : "Save"}
            </button>
          </div>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      {(card.state === "configured_running" ||
        card.state === "configured_starting" ||
        card.state === "error") && (
        <div className="mt-5 space-y-2">
          <button onClick={disconnect} disabled={busy} className="btn-ghost">
            {busy ? "…" : "Disconnect"}
          </button>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      <RestartScopeWarning scope={lastResp?.restart_scope} warning={lastResp?.restart_warning} />
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// SlackSection.
// --------------------------------------------------------------------------
function ProfileSlackSection({
  slug,
  entry,
  refetch,
}: {
  slug: string;
  entry: ChannelStatusEntry<SlackStatus> | null;
  refetch: () => void;
}) {
  const card = deriveSlackCardState({
    status: entry?.ok ? (entry.status as SlackStatus | null) : null,
  });
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);

  const valid =
    /^xoxb-[0-9A-Za-z_-]{8,}$/.test(botToken.trim()) &&
    /^xapp-[0-9A-Za-z_-]{8,}$/.test(appToken.trim());

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await setProfileChannelToken({
        slug,
        channel_kind: "slack",
        payload: {
          bot_token: botToken.trim(),
          app_token: appToken.trim(),
        },
      });
      setLastResp(resp);
      setBotToken("");
      setAppToken("");
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't save the tokens.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await clearProfileChannelToken({
        slug,
        channel_kind: "slack",
      });
      setLastResp(resp);
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't disconnect.");
    } finally {
      setBusy(false);
    }
  }

  const address =
    card.state === "configured_running"
      ? card.heading
      : card.state === "configured_starting"
        ? "Restarting…"
        : card.state === "error"
          ? "Slack rejected the token"
          : "Not yet configured";

  return (
    <ChannelCard
      name="Slack"
      address={address}
      note={`Workspace tokens scoped to '${slug}'.`}
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Bot OAuth + App tokens · for {slug}
          </div>
          <input
            type={show ? "text" : "password"}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="xoxb-…"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <input
            type={show ? "text" : "password"}
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder="xapp-…"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="btn-link"
            >
              {show ? "Hide" : "Show"}
            </button>
            <button
              onClick={save}
              disabled={busy || !valid}
              className="btn-ghost"
            >
              {busy ? "…" : "Save"}
            </button>
          </div>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      {(card.state === "configured_running" ||
        card.state === "configured_starting" ||
        card.state === "error") && (
        <div className="mt-5 space-y-2">
          <button onClick={disconnect} disabled={busy} className="btn-ghost">
            {busy ? "…" : "Disconnect"}
          </button>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      <RestartScopeWarning scope={lastResp?.restart_scope} warning={lastResp?.restart_warning} />
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// SmsSection.
// --------------------------------------------------------------------------
function ProfileSmsSection({
  slug,
  entry,
  refetch,
}: {
  slug: string;
  entry: ChannelStatusEntry<SmsStatus> | null;
  refetch: () => void;
}) {
  const card = deriveSmsCardState({
    status: entry?.ok ? (entry.status as SmsStatus | null) : null,
  });
  const [sid, setSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [from, setFrom] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);

  const valid =
    /^AC[a-f0-9]{32}$/.test(sid.trim()) &&
    /^[a-f0-9]{32}$/.test(authToken.trim()) &&
    /^\+[1-9]\d{1,14}$/.test(from.trim());

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await setProfileChannelToken({
        slug,
        channel_kind: "sms",
        payload: {
          account_sid: sid.trim(),
          auth_token: authToken.trim(),
          phone_number: from.trim(),
        },
      });
      setLastResp(resp);
      setSid("");
      setAuthToken("");
      setFrom("");
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't save the creds.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await clearProfileChannelToken({
        slug,
        channel_kind: "sms",
      });
      setLastResp(resp);
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't disconnect.");
    } finally {
      setBusy(false);
    }
  }

  const address =
    card.state === "configured_running"
      ? card.heading
      : card.state === "configured_starting"
        ? "Restarting…"
        : card.state === "error"
          ? "Twilio rejected the creds"
          : "Not yet configured";

  return (
    <ChannelCard
      name="SMS"
      address={address}
      note={`Twilio credentials scoped to '${slug}'.`}
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Twilio · for {slug}
          </div>
          <input
            type={show ? "text" : "password"}
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            placeholder="Account SID (AC…)"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <input
            type={show ? "text" : "password"}
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="Auth token (32 hex)"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="+15551234567"
            className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="btn-link"
            >
              {show ? "Hide" : "Show"}
            </button>
            <button
              onClick={save}
              disabled={busy || !valid}
              className="btn-ghost"
            >
              {busy ? "…" : "Save"}
            </button>
          </div>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      {(card.state === "configured_running" ||
        card.state === "configured_starting" ||
        card.state === "error") && (
        <div className="mt-5 space-y-2">
          <button onClick={disconnect} disabled={busy} className="btn-ghost">
            {busy ? "…" : "Disconnect"}
          </button>
          {err && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
      <RestartScopeWarning scope={lastResp?.restart_scope} warning={lastResp?.restart_warning} />
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// PaperclipSection.
// --------------------------------------------------------------------------
function ProfilePaperclipSection({
  slug,
  entry,
  refetch,
}: {
  slug: string;
  entry: ChannelStatusEntry<PaperclipStatus> | null;
  refetch: () => void;
}) {
  // Paperclip's status shape is profile-agnostic on /status (the heartbeat
  // surface is principal-instance scoped). We use derivePaperclipCardState's
  // pill but key the actions to this profile's .env via the new ops.
  const status = entry?.ok ? (entry.status as PaperclipStatus | null) : null;
  const card = derivePaperclipCardState(status);
  const [apiKey, setApiKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);

  async function save() {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const resp = await setProfileChannelToken({
        slug,
        channel_kind: "paperclip",
        payload: { api_key: apiKey.trim() },
      });
      setLastResp(resp);
      setApiKey("");
      refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't save the key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChannelCard
      name="Paperclip"
      address={card.heading || "Not yet configured"}
      note={`Paperclip API key scoped to '${slug}'.`}
      status={card.pillTone as ChannelStatus}
    >
      <div className="mt-5 space-y-3">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Paperclip API key · for {slug}
        </div>
        <div className="flex gap-2 items-baseline">
          <input
            type={show ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="pcp_…"
            className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="btn-link"
          >
            {show ? "Hide" : "Show"}
          </button>
          <button
            onClick={save}
            disabled={busy || !apiKey.trim()}
            className="btn-ghost"
          >
            {busy ? "…" : "Save"}
          </button>
        </div>
        {err && (
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {err}
          </p>
        )}
      </div>
      <RestartScopeWarning scope={lastResp?.restart_scope} warning={lastResp?.restart_warning} />
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// #120 Lane Vb2 — per-profile Email (AgentMail) section. Reads
// /api/v1/channels/email/status?profile=<slug>; renders provision /
// disconnect / send-test as a single ChannelCard. Lives in its own query
// (getProfileEmailStatus) rather than the consolidator so the operator
// can independently refetch after a provision.
// --------------------------------------------------------------------------
interface ProfileEmailStatus {
  configured: boolean;
  profile: string;
  inbox_address: string | null;
  inbox_id: string | null;
  binding_id: string | null;
  provision_available: boolean;
  provision_unavailable_reason: string | null;
  env_error: string | null;
}

function ProfileEmailSection({ slug }: { slug: string }) {
  const statusQ = useQuery(getProfileEmailStatus, { slug });
  const status = (statusQ.data as ProfileEmailStatus | undefined) ?? null;
  const [prefix, setPrefix] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<null | "provision" | "disconnect" | "test">(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);

  const configured = Boolean(status?.configured);
  const provisionAvailable = status?.provision_available !== false;

  async function doProvision() {
    if (busy) return;
    setBusy("provision");
    setErr(null);
    try {
      const resp = await provisionProfileEmailInbox({
        slug,
        prefix: prefix.trim() || undefined,
      });
      setLastResp(resp);
      setPrefix("");
      statusQ.refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't provision the inbox.");
    } finally {
      setBusy(null);
    }
  }

  async function doDisconnect() {
    if (busy) return;
    if (
      !window.confirm(
        `Release ${status?.inbox_address ?? "this inbox"}? Inbound emails to that address will stop being delivered to ${slug}.`,
      )
    ) {
      return;
    }
    setBusy("disconnect");
    setErr(null);
    try {
      const resp = await clearProfileEmailInbox({ slug });
      setLastResp(resp);
      statusQ.refetch();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't release the inbox.");
    } finally {
      setBusy(null);
    }
  }

  async function doTest() {
    if (busy || !testTo.trim()) return;
    setBusy("test");
    setErr(null);
    try {
      const resp = await sendProfileEmailTest({ slug, to: testTo.trim() });
      setLastResp(resp);
      setTestTo("");
    } catch (e: any) {
      setErr(e?.message ?? "Test send failed.");
    } finally {
      setBusy(null);
    }
  }

  const address = configured
    ? (status?.inbox_address as string)
    : "Not yet provisioned";
  const note = configured
    ? `Inbox '${status?.inbox_address}' is bound to '${slug}'. Inbound mail routes here; outbound replies use this inbox's credentials.`
    : provisionAvailable
      ? `No inbox yet. Provision one and AgentMail mints a fresh address scoped to '${slug}'.`
      : "Per-profile inbox provisioning is unavailable on this tenant — see the operator hint below.";
  const cardStatus: ChannelStatus = configured
    ? "connected"
    : provisionAvailable
      ? "available"
      : "unavailable";

  return (
    <ChannelCard
      name="Email"
      address={address}
      note={note}
      status={cardStatus}
    >
      <div className="mt-5 space-y-3">
        {status?.env_error && (
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            Could not read the profile's .env: {status.env_error}
          </p>
        )}
        {!configured && (
          <>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Provision new inbox · for {slug}
            </div>
            {!provisionAvailable && status?.provision_unavailable_reason && (
              <p
                className="font-body italic text-[13px]"
                style={{ color: "var(--marginalia)" }}
              >
                {status.provision_unavailable_reason}
              </p>
            )}
            <div className="flex gap-2 items-baseline">
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder={`alfred.${slug} (default)`}
                disabled={!provisionAvailable || busy === "provision"}
                className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              <button
                onClick={doProvision}
                disabled={!provisionAvailable || busy === "provision"}
                className="btn-ghost"
              >
                {busy === "provision" ? "…" : "Provision"}
              </button>
            </div>
          </>
        )}
        {configured && (
          <>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Send a test email
            </div>
            <div className="flex gap-2 items-baseline">
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="recipient@example.com"
                disabled={busy === "test"}
                className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              <button
                onClick={doTest}
                disabled={busy === "test" || !testTo.trim()}
                className="btn-ghost"
              >
                {busy === "test" ? "…" : "Send"}
              </button>
            </div>
            <div className="pt-2">
              <button
                onClick={doDisconnect}
                disabled={busy === "disconnect"}
                className="btn-link"
                style={{ color: "var(--brass)" }}
              >
                {busy === "disconnect" ? "…" : "Disconnect inbox"}
              </button>
            </div>
          </>
        )}
        {err && (
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {err}
          </p>
        )}
        {lastResp?.ok && lastResp.address && (
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            Provisioned {lastResp.address}.
            {lastResp.webhook_registered === false &&
              " AgentMail webhook registration failed — inbound may need a manual hook."}
          </p>
        )}
        {lastResp?.message_id && (
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            Test sent (message_id: {String(lastResp.message_id).slice(0, 12)}…).
          </p>
        )}
      </div>
      <RestartScopeWarning scope={lastResp?.restart_scope} warning={lastResp?.restart_warning} />
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// InstanceLevelNotice. For voice / OMI / HA / Recall / Tailscale /
// Terminal we render a small read-only card pointing at /channels.
// --------------------------------------------------------------------------
function InstanceLevelNotice({
  name,
  reason,
}: {
  name: string;
  reason: string;
}) {
  return (
    <ChannelCard
      name={name}
      address="Configured at the instance level"
      note={reason}
      status="available"
    >
      <Link to="/channels" className="btn-ghost mt-4 inline-block">
        Open instance-level channels →
      </Link>
    </ChannelCard>
  );
}

// --------------------------------------------------------------------------
// Page.
// --------------------------------------------------------------------------
export default function ProfileChannelsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";

  // Verify the profile exists + isn't archived. /profiles/:slug/channels for
  // an unknown slug renders an error frame (back-link to /profiles).
  const profileQ = useQuery(
    getAgentProfile,
    { slug },
    { retry: false },
  );
  const profile = (profileQ.data as any)?.profile as ProfileRow | undefined;

  const statusesQ = useQuery(
    getProfileChannelStatuses,
    { slug },
    { retry: false, enabled: !!profile && profile.status !== "archived" },
  );
  const statuses = (statusesQ.data as ProfileChannelStatuses | undefined) ?? null;
  function refetch() {
    statusesQ.refetch();
  }
  function entryFor<T = unknown>(
    kind: ChannelStatusEntry["kind"],
  ): ChannelStatusEntry<T> | null {
    return (
      (statuses?.channels.find((c) => c.kind === kind) as
        | ChannelStatusEntry<T>
        | undefined) ?? null
    );
  }

  if (profileQ.isLoading) {
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

  if (profileQ.error || !profile) {
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
              {(profileQ.error as any)?.message ||
                "The registry didn't return a row for this slug."}
            </p>
          </div>
        </section>
      </Frame>
    );
  }

  if (profile.status === "archived" || profile.archived_at != null) {
    return (
      <Frame>
        <section className="mx-auto max-w-[1080px] px-8 py-12">
          <Link
            to={`/profiles/${slug}`}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            ← Back to {profile.label}
          </Link>
          <div className="border border-rule p-8 mt-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              {profile.label} is archived
            </div>
            <p
              className="font-body italic"
              style={{ color: "var(--marginalia)" }}
            >
              Restore the profile before changing its channels.
            </p>
          </div>
        </section>
      </Frame>
    );
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1100px] px-8 py-12">
        <div className="mb-2">
          <Link
            to={`/profiles/${slug}`}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            ← Back to {profile.label}
          </Link>
        </div>

        <PageHeading
          kicker={`profile · ${profile.slug}`}
          title={`Channels for ${profile.label}`}
          lede="Each channel here is scoped to this profile. Set its tokens and only this profile picks them up — main keeps its own."
          icon="calling_card"
        />

        <div className="mb-8 flex items-baseline gap-x-6">
          <Link
            to="/channels"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Main profile's channels →
          </Link>
        </div>

        {statusesQ.isLoading && (
          <p
            className="font-body italic mb-6"
            style={{ color: "var(--marginalia)" }}
          >
            Reading status from the gateway…
          </p>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          <ProfileTelegramSection slug={slug} entry={entryFor<TelegramStatus>("telegram")} refetch={refetch} />
          <ProfileSlackSection slug={slug} entry={entryFor<SlackStatus>("slack")} refetch={refetch} />
          <ProfileSmsSection slug={slug} entry={entryFor<SmsStatus>("sms")} refetch={refetch} />
          <ProfilePaperclipSection slug={slug} entry={entryFor<PaperclipStatus>("paperclip")} refetch={refetch} />
          <ProfileEmailSection slug={slug} />

          {/* Honest partials — these channels are instance-level by design. */}
          <InstanceLevelNotice
            name="Voice"
            reason="Voice-bridge is a single compose sibling. One Twilio number + one OPENAI key per VM."
          />
          <InstanceLevelNotice
            name="Home Assistant"
            reason="One household, one HA URL + LLAT. Configure once."
          />
          <InstanceLevelNotice
            name="OMI"
            reason="One device per household. The Groq key is consumed by alfred-learn, which is instance-level."
          />
          <InstanceLevelNotice
            name="Recall.ai"
            reason="One Recall account; meeting bots are dispatched per-bot, not per-profile."
          />
        </div>
      </section>
    </Frame>
  );
}
