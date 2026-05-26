// ChannelsPage — live channels (#864).
//
// One card per door into Alfred. Web/email/phone/vexa/omi pull live
// data from the existing Wasp ops; Slack/Telegram are "Soon" placeholders.
// Sir #8 — also surfaces a "Terminal" card with SSH info + the
// `docker exec ... hermes` command for direct shell access.
import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  getPhoneConfig,
  getEmailChannelStatus,
  provisionEmail,
  provisionPhone,
  addAuthorizedNumber,
  removeAuthorizedNumber,
  getVexaAutoJoin,
  setVexaAutoJoin,
  getSshInfo,
  getTelegramChannelStatus,
  setTelegramBotToken,
  sendTelegramTest,
  revokeTelegramChat,
  disconnectTelegram,
  getSlackChannelStatus,
  getSlackManifest,
  setSlackTokens,
  sendSlackTest,
  disconnectSlack,
  getSmsChannelStatus,
  setSmsCredentials,
  sendSmsTest,
  disconnectSms,
  getVoiceChannelStatus,
  getOmiChannelStatus,
  setOmiGroqKey,
  disconnectOmiGroqKey,
  sendOmiTest,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import {
  deriveTerminalCardState,
  type SshInfo,
} from "./terminalCardCore";
import {
  deriveTelegramCardState,
  isProbablyValidBotToken,
  type TelegramStatus,
} from "./telegramCardCore";
import {
  deriveSlackCardState,
  isProbablyValidSlackBotToken,
  isProbablyValidSlackAppToken,
  type SlackStatus,
} from "./slackCardCore";
import {
  deriveSmsCardState,
  isProbablyValidTwilioAccountSid,
  isProbablyValidTwilioAuthToken,
  type SmsStatus,
} from "./smsCardCore";
import {
  deriveVoiceCardState,
  type VoiceStatus,
} from "./voiceCardCore";
import {
  deriveOmiCardState,
  isProbablyValidGroqKey,
  type OmiStatus,
} from "./omiCardCore";

// F57/C14 — the email card reads the live ctrl-api status, not a phantom
// Instance row. `inbox_address` is only present once `configured`.
interface EmailChannelStatus {
  configured: boolean;
  inbox_address: string | null;
}

// F58/C15 — getPhoneConfig returns the ctrl-api phone config shape. The card
// previously read `twilio_number`/`authorized_numbers`, which never match the
// ctrl-api keys, so the card stayed "Not yet provisioned" even after wiring.
interface PhoneConfig {
  phoneNumber: string | null;
  authorizedNumbers?: string[];
  recentActivity?: unknown[];
}

// Sir #8 — Terminal card shape lives in terminalCardCore so the pure
// derivation (and its unit test) can stay free of React/Wasp imports.

export default function ChannelsPage() {
  const { data: emailData, refetch: refetchEmail } = useQuery(
    getEmailChannelStatus,
    undefined,
    { retry: false },
  );
  const { data: phoneData, refetch: refetchPhone } = useQuery(
    getPhoneConfig,
    undefined,
    { retry: false },
  );
  const { data: vexaData, refetch: refetchVexa } = useQuery(
    getVexaAutoJoin,
    undefined,
    { retry: false },
  );
  // Sir #8 — SSH info for the Terminal card. ctrl-api returns nulls
  // when SSH isn't provisioned yet; the card renders an empty state
  // in that case.
  const { data: sshData } = useQuery(getSshInfo, undefined, { retry: false });
  const email = (emailData as EmailChannelStatus | undefined) ?? {
    configured: false,
    inbox_address: null,
  };
  const phone = (phoneData as PhoneConfig | undefined) ?? { phoneNumber: null };
  const phoneNumber: string = phone.phoneNumber ?? "";
  const authorized: string[] = Array.isArray(phone.authorizedNumbers)
    ? phone.authorizedNumbers
    : [];
  const vexaEnabled: boolean = Boolean((vexaData as any)?.enabled);
  const ssh: SshInfo = (sshData as SshInfo | undefined) ?? {
    hostname: null,
    port: null,
    user: null,
    pubkey: null,
    hermes_exec: null,
  };

  // Email-form state (F57).
  const [emailKey, setEmailKey] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Phone-form state.
  const [newNumber, setNewNumber] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [vexaBusy, setVexaBusy] = useState(false);

  // Phone setup-form state (F58/C15 — BYO existing number only).
  const [setupOpen, setSetupOpen] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [byoNumber, setByoNumber] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const setupReady =
    openaiKey.trim() &&
    twilioSid.trim() &&
    twilioToken.trim() &&
    byoNumber.trim();

  async function doProvisionPhone() {
    if (!setupReady) return;
    setSetupBusy(true);
    setSetupError(null);
    try {
      await provisionPhone({
        openai_api_key: openaiKey.trim(),
        twilio_account_sid: twilioSid.trim(),
        twilio_auth_token: twilioToken.trim(),
        phone_number: byoNumber.trim(),
      });
      setOpenaiKey("");
      setTwilioSid("");
      setTwilioToken("");
      setByoNumber("");
      setSetupOpen(false);
      await refetchPhone();
    } catch (e: any) {
      // ctrl-api returns 4xx `{ error }` (e.g. buy_not_supported, bad creds).
      setSetupError(
        e?.message ?? e?.data?.error ?? "Setup failed — check the credentials.",
      );
    } finally {
      setSetupBusy(false);
    }
  }

  async function doProvisionEmail() {
    const key = emailKey.trim();
    if (!key) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      await provisionEmail({ api_key: key });
      setEmailKey("");
      await refetchEmail();
    } catch (e: any) {
      // ctrl-api returns a 4xx `{ error }` for an invalid key.
      setEmailError(
        e?.message ?? e?.data?.error ?? "Provisioning failed — check the key.",
      );
    } finally {
      setEmailBusy(false);
    }
  }

  async function addNumber() {
    const n = newNumber.trim();
    if (!n) return;
    setPhoneBusy(true);
    try {
      await addAuthorizedNumber({ number: n });
      setNewNumber("");
      await refetchPhone();
    } catch (e) {
      console.error("add number failed", e);
    } finally {
      setPhoneBusy(false);
    }
  }

  async function removeNumber(n: string) {
    setPhoneBusy(true);
    try {
      await removeAuthorizedNumber({ number: n });
      await refetchPhone();
    } catch (e) {
      console.error("remove number failed", e);
    } finally {
      setPhoneBusy(false);
    }
  }

  async function toggleVexa() {
    setVexaBusy(true);
    try {
      await setVexaAutoJoin({ enabled: !vexaEnabled });
      await refetchVexa();
    } catch (e) {
      console.error("vexa toggle failed", e);
    } finally {
      setVexaBusy(false);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1100px] px-8 py-12">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Channels
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-3">
          Wherever you already are.
        </h1>
        <p
          className="font-body text-[16px] max-w-[60ch] mb-12"
          style={{ color: "var(--marginalia)" }}
        >
          Same Alfred, same memory — pick the door that suits the moment.
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Web */}
          <ChannelCard
            name="Web app"
            address="alfred.black/chat"
            note="The long thread, in the browser."
            status="active"
          >
            <div className="mt-4 flex gap-4">
              <Link to="/chat" className="btn-ghost inline-block">
                Open chat →
              </Link>
              <Link to="/desk" className="btn-ghost inline-block">
                Open the desk →
              </Link>
            </div>
          </ChannelCard>

          {/* Email — F57/C14: live status from getEmailChannelStatus. */}
          <ChannelCard
            name="Email"
            address={
              email.configured
                ? email.inbox_address || "Connected"
                : "Credential not set"
            }
            note="Forward anything; I read attachments and PDFs."
            status={email.configured ? "active" : "available"}
          >
            {email.configured ? (
              // The inbox lives in the vault's `inbox/` folder; the old
              // /dashboard/inbox link was a dead redirect.
              <Link to="/vault" className="btn-ghost mt-4 inline-block">
                Open the vault →
              </Link>
            ) : (
              <div className="mt-5 space-y-3">
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  AgentMail API key
                </div>
                <div className="flex gap-2 items-baseline">
                  <input
                    type="password"
                    value={emailKey}
                    onChange={(e) => setEmailKey(e.target.value)}
                    placeholder="am_live_…"
                    className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                  />
                  <button
                    onClick={doProvisionEmail}
                    disabled={emailBusy || !emailKey.trim()}
                    className="btn-ghost"
                  >
                    {emailBusy ? "…" : "Provision"}
                  </button>
                </div>
                {emailError && (
                  <p
                    className="font-body italic text-[13px]"
                    style={{ color: "var(--brass)" }}
                  >
                    {emailError}
                  </p>
                )}
              </div>
            )}
          </ChannelCard>

          {/* Phone — split into two sections (Lane III SMS, 2026-05-25):
              the SMS half is the new live SmsCard backed by ctrl-api
              /api/v1/channels/sms/*; the Voice half is the existing F58/C15
              BYO-Twilio provisioning + authorised-callers form, untouched.
              A "SMS" / "Voice" divider keeps the card from reading as one
              giant form. Phase 2 will pull Voice out of this card entirely. */}
          <ChannelCard
            name="Phone"
            address={phoneNumber || "SMS or voice — pick a section below"}
            note="SMS replies in the butler voice; voice rings through Twilio."
            status={phoneNumber ? "active" : "available"}
          >
            {/* ---------- SMS section (NEW) ---------- */}
            <SectionDivider label="SMS" />
            <SmsSection />

            {/* ---------- Voice section (Lane III voice, 2026-05-25) ----------
                Voice is now a real compose service (voice-bridge) — see
                Lane I + Lane II. The card is read-only because voice
                reuses Twilio credentials from the SMS section above.
                Surfaces deploy-readiness only; no operator settings. */}
            <SectionDivider label="Voice" />
            <VoiceSection />
          </ChannelCard>

          {/* Vexa */}
          <ChannelCard
            name="Meeting bot"
            address={vexaEnabled ? "Auto-joining your meetings" : "Off"}
            note="A second pair of ears for Zoom, Meet, Teams."
            status={vexaEnabled ? "active" : "available"}
          >
            <button
              onClick={toggleVexa}
              disabled={vexaBusy}
              className="btn-ghost mt-4"
            >
              {vexaBusy
                ? "…"
                : vexaEnabled
                  ? "Stop auto-joining"
                  : "Start auto-joining"}
            </button>
          </ChannelCard>

          {/* Omi — Phase-6b live card (Lane III, 2026-05-25). Surfaces the
              4 OMI channel states (unconfigured / needs_groq_key /
              configured / error). The Groq key is stored server-side in
              Vaultwarden; alfred-learn reads it at transcription-activity
              time. State derivation lives in omiCardCore. */}
          <OmiCard />

          {/* Slack — Lane III: live card backed by ctrl-api, mirror of
              TelegramCard. The four visual states + workspace info come
              from slackCardCore. */}
          <SlackCard />

          {/* Telegram — Lane III: live card backed by ctrl-api. The four
              visual states (unconfigured / configured_starting /
              configured_running / error) come from telegramCardCore. */}
          <TelegramCard />

          {/* Sir #8 — Terminal: SSH straight into the VM + `docker exec`
              into Hermes for the chattiest, lowest-latency door. */}
          <TerminalCard ssh={ssh} />
        </div>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Sir #8 — Terminal card (state derivation lives in terminalCardCore)
// ---------------------------------------------------------------------------

export function TerminalCard({ ssh }: { ssh: SshInfo }) {
  const { ready, sshTarget, hermesExec } = deriveTerminalCardState(ssh);

  return (
    <ChannelCard
      name="Terminal"
      address={ready ? sshTarget : "Set up your SSH key first"}
      note="The shortest path: SSH in and talk to Hermes directly."
      status={ready ? "active" : "available"}
    >
      {ready ? (
        <div className="mt-5 space-y-5">
          <PubkeyBlock pubkey={ssh.pubkey!} />
          <ConnectBlock hermesExec={hermesExec} />
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            Add the key above to your <code>~/.ssh/authorized_keys</code>{" "}
            (already done if you provisioned this VM), then SSH in and run
            the command above to talk to Alfred directly.
          </p>
        </div>
      ) : (
        <div className="mt-5">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            No SSH key on file for this instance yet. Set one up in{" "}
            <Link to="/study#credentials" className="btn-link">
              Study › Credentials
            </Link>
            , then come back — the card will fill in automatically.
          </p>
        </div>
      )}
    </ChannelCard>
  );
}

function PubkeyBlock({ pubkey }: { pubkey: string }) {
  // The href is rebuilt every render but it's tiny (< 4KB) and React only
  // re-mounts the anchor when the pubkey changes, so this is cheap. The
  // Blob URL is leaked on unmount, which is fine for a card-sized control.
  const href =
    typeof window !== "undefined" && typeof Blob !== "undefined"
      ? URL.createObjectURL(new Blob([pubkey], { type: "text/plain" }))
      : "";
  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--marginalia)" }}
      >
        Public key
      </div>
      <pre
        className="font-mono text-[11px] border border-rule p-3 whitespace-pre-wrap break-all max-h-32 overflow-y-auto"
        style={{ color: "var(--ink)" }}
      >
        {pubkey}
      </pre>
      <a
        href={href}
        download="alfred-ssh-key.pub"
        className="btn-ghost mt-2 inline-block"
      >
        Download key
      </a>
    </div>
  );
}

function ConnectBlock({ hermesExec }: { hermesExec: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(hermesExec);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--marginalia)" }}
      >
        Connect to Alfred
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 font-mono text-[12px] border border-rule p-2 truncate"
          style={{ color: "var(--ink)" }}
        >
          {hermesExec}
        </code>
        <button onClick={copy} className="btn-ghost">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Lane III — Telegram card. State derivation lives in telegramCardCore;
// the component below is the React surface + form plumbing only. All four
// visual states render inline off the derived `card.state` so we avoid a
// fan-out of tiny sub-components.
// ---------------------------------------------------------------------------

function TelegramCard() {
  const { data: statusData, refetch } = useQuery(
    getTelegramChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as TelegramStatus | undefined) ?? null;
  const card = deriveTelegramCardState({ status });

  // Setup-state form
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Test-message state — toast-style "✓ Sent…" / "✗ <reason>" line.
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  // Per-chat revoke busy set (chat_id → in-flight).
  const [revokeBusy, setRevokeBusy] = useState<Set<string>>(new Set());
  // Shared disconnect
  const [discBusy, setDiscBusy] = useState(false);

  const trimmed = token.trim();
  const tokenValid = isProbablyValidBotToken(trimmed);
  const tokenHint =
    trimmed.length > 0 && !tokenValid
      ? "That doesn't look like a bot token (shape is digits:secret)."
      : null;

  async function save() {
    if (!tokenValid) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      await setTelegramBotToken({ token: trimmed });
      setToken("");
      refetch();
    } catch (e: any) {
      setSaveErr(e?.message ?? e?.data?.error ?? "Couldn't save the token.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function sendTest() {
    if (testBusy) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await sendTelegramTest({});
      if (r?.ok) {
        setTestMsg({
          kind: "ok",
          text: "Sent — check your phone.",
        });
      } else {
        setTestMsg({
          kind: "err",
          text: r?.error ?? "Telegram refused the message.",
        });
      }
    } catch (e: any) {
      setTestMsg({
        kind: "err",
        text: e?.message ?? e?.data?.error ?? "Couldn't reach the bot.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  async function revokeChat(chatId: string | number) {
    const idStr = String(chatId);
    if (revokeBusy.has(idStr)) return;
    setRevokeBusy(new Set([...revokeBusy, idStr]));
    try {
      await revokeTelegramChat({ chat_id: idStr });
      refetch();
    } catch (e) {
      console.error("telegram revoke failed", e);
    } finally {
      setRevokeBusy((prev) => {
        const next = new Set(prev);
        next.delete(idStr);
        return next;
      });
    }
  }

  async function disconnect() {
    if (discBusy) return;
    setDiscBusy(true);
    try {
      await disconnectTelegram({});
      refetch();
    } catch (e) {
      console.error("telegram disconnect failed", e);
    } finally {
      setDiscBusy(false);
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
      note="For when you're abroad."
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            Bot token
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
              disabled={saveBusy || !tokenValid}
              className="btn-ghost"
            >
              {saveBusy ? "…" : "Save token"}
            </button>
          </div>
          {tokenHint && (
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              {tokenHint}
            </p>
          )}
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            Get one from @BotFather on Telegram: send <code>/newbot</code>,
            give it a name and a username, and paste the token it returns
            above.
          </p>
          {saveErr && (
            <p
              className="font-body italic text-[13px]"
              style={{ color: "var(--brass)" }}
            >
              {saveErr}
            </p>
          )}
        </div>
      )}

      {card.state === "configured_starting" && (
        <div className="mt-5 flex items-baseline gap-2">
          <span
            className="font-mono text-[12px] animate-pulse"
            style={{ color: "var(--marginalia)" }}
          >
            ●
          </span>
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            Hermes is picking up the new token. This usually takes a few
            seconds.
          </p>
        </div>
      )}

      {card.state === "configured_running" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {card.showChatList && (
            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Paired chats
              </div>
              <ul className="space-y-1">
                {card.pairedChats.map((c) => {
                  const idStr = String(c.id);
                  const busy = revokeBusy.has(idStr);
                  return (
                    <li
                      key={idStr}
                      className="flex items-baseline gap-3 border-b border-rule/40 pb-1"
                    >
                      <span
                        className="flex-1 font-body text-[13px]"
                        style={{ color: "var(--ink)" }}
                      >
                        {c.name ?? `chat ${idStr}`}
                        {c.type && (
                          <span
                            className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em]"
                            style={{ color: "var(--marginalia)" }}
                          >
                            {c.type}
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => revokeChat(c.id)}
                        disabled={busy}
                        className="btn-link text-[11px]"
                        title="Remove this chat from the allowlist"
                      >
                        {busy ? "…" : "Revoke"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            <button
              onClick={sendTest}
              disabled={testBusy}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Send test message"}
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect bot
            </button>
          </div>

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
        </div>
      )}

      {card.state === "error" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <div className="flex gap-3 items-baseline">
            <button onClick={() => refetch()} className="btn-ghost">
              Try again
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </ChannelCard>
  );
}

// ---------------------------------------------------------------------------
// Lane III — Slack card. State derivation in slackCardCore; the component
// below is the React surface only. Mirrors TelegramCard.
//
// THE SETUP UX (manifest paste, per Sir's 2026-05-25 design choice):
//   1. Read the manifest JSON from ctrl-api (`hermes slack manifest`).
//   2. Show it in a copy-paste box pointing at api.slack.com/apps "From an
//      app manifest" wizard.
//   3. Two token inputs (bot xoxb-…, app xapp-…) + Phase-2 optional fields
//      (home_channel, allowed_users, allowed_channels).
//   4. Save → ctrl-api PUT /tokens → vault write + .env write + hermes restart
//   5. UI re-polls /status; card flips to configured_starting → running once
//      Slack's auth.test confirms the bot token.
// ---------------------------------------------------------------------------

function SlackCard() {
  const { data: statusData, refetch } = useQuery(
    getSlackChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as SlackStatus | undefined) ?? null;
  const card = deriveSlackCardState({ status });

  // Setup-state form
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [allowedUsers, setAllowedUsers] = useState("");
  const [homeChannel, setHomeChannel] = useState("");
  const [allowedChannels, setAllowedChannels] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Test-message state.
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  // Disconnect.
  const [discBusy, setDiscBusy] = useState(false);

  // Manifest — fetched lazily once the user expands the setup wizard.
  const { data: manifestData } = useQuery(
    getSlackManifest,
    undefined,
    { retry: false, enabled: card.state === "unconfigured" } as any,
  );
  const manifestJson =
    (manifestData as { manifest?: string } | undefined)?.manifest ?? "";

  const trimmedBot = botToken.trim();
  const trimmedApp = appToken.trim();
  const botValid = isProbablyValidSlackBotToken(trimmedBot);
  const appValid = isProbablyValidSlackAppToken(trimmedApp);
  const tokensValid = botValid && appValid;
  const botHint =
    trimmedBot.length > 0 && !botValid
      ? "Bot token must look like xoxb-…"
      : null;
  const appHint =
    trimmedApp.length > 0 && !appValid
      ? "App token must look like xapp-…"
      : null;

  async function save() {
    if (!tokensValid) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      await setSlackTokens({
        bot_token: trimmedBot,
        app_token: trimmedApp,
        allowed_users: allowedUsers.trim() || undefined,
        home_channel: homeChannel.trim() || undefined,
        allowed_channels: allowedChannels.trim() || undefined,
      });
      setBotToken("");
      setAppToken("");
      refetch();
    } catch (e: any) {
      setSaveErr(e?.message ?? e?.data?.error ?? "Couldn't save the tokens.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function sendTest() {
    if (testBusy) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await sendSlackTest({});
      if (r?.ok) {
        setTestMsg({ kind: "ok", text: "Sent — check Slack." });
      } else {
        setTestMsg({
          kind: "err",
          text: r?.error ?? "Slack refused the message.",
        });
      }
    } catch (e: any) {
      setTestMsg({
        kind: "err",
        text: e?.message ?? e?.data?.error ?? "Couldn't reach Slack.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  async function disconnect() {
    if (discBusy) return;
    setDiscBusy(true);
    try {
      await disconnectSlack({});
      refetch();
    } catch (e) {
      console.error("slack disconnect failed", e);
    } finally {
      setDiscBusy(false);
    }
  }

  function copyManifest() {
    if (manifestJson) {
      navigator.clipboard?.writeText(manifestJson);
    }
  }

  const address =
    card.state === "configured_running"
      ? card.workspace.team ?? card.heading
      : card.state === "configured_starting"
        ? "Restarting…"
        : card.state === "error"
          ? "Token rejected"
          : "Not yet configured";

  return (
    <ChannelCard
      name="Slack"
      address={address}
      note="DMs and mentions, in your team's workspace."
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {/* Manifest box — copy-paste into api.slack.com/apps */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Step 1 · Slack app manifest
              </div>
              <button onClick={copyManifest} className="btn-link text-[11px]">
                Copy
              </button>
            </div>
            <pre
              className="font-mono text-[11px] border border-rule p-2 overflow-auto max-h-48 whitespace-pre-wrap"
              style={{ color: "var(--ink)" }}
            >
              {manifestJson || "(loading…)"}
            </pre>
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              Paste this at{" "}
              <a
                href="https://api.slack.com/apps?new_app=1"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                api.slack.com/apps
              </a>{" "}
              → Create New App → From an app manifest. Pick your workspace, then
              install. After install, go to OAuth & Permissions (Bot Token) and
              Settings → Basic Information → App-Level Tokens (with{" "}
              <code>connections:write</code>).
            </p>
          </div>

          {/* Two-token form */}
          <div className="space-y-3">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Step 2 · Paste both tokens
            </div>
            <div className="flex gap-2 items-baseline">
              <input
                type={showSecrets ? "text" : "password"}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-… (Bot User OAuth Token)"
                className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => setShowSecrets((s) => !s)}
                className="btn-link"
              >
                {showSecrets ? "Hide" : "Show"}
              </button>
            </div>
            {botHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {botHint}
              </p>
            )}
            <input
              type={showSecrets ? "text" : "password"}
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
              placeholder="xapp-… (App-Level Token)"
              className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            {appHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {appHint}
              </p>
            )}

            {/* Phase-2 options — folded by default */}
            <button
              type="button"
              onClick={() => setShowOptions((s) => !s)}
              className="btn-link text-[11px]"
            >
              {showOptions ? "Hide options" : "Options (allowlist + home channel)"}
            </button>
            {showOptions && (
              <div className="space-y-2 border-l border-rule/40 pl-3">
                <input
                  type="text"
                  value={homeChannel}
                  onChange={(e) => setHomeChannel(e.target.value)}
                  placeholder="SLACK_HOME_CHANNEL — channel id for proactive notifications (optional)"
                  className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
                />
                <input
                  type="text"
                  value={allowedUsers}
                  onChange={(e) => setAllowedUsers(e.target.value)}
                  placeholder="SLACK_ALLOWED_USERS — comma-separated user ids (empty = everyone)"
                  className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
                />
                <input
                  type="text"
                  value={allowedChannels}
                  onChange={(e) => setAllowedChannels(e.target.value)}
                  placeholder="SLACK_ALLOWED_CHANNELS — comma-separated channel ids (empty = all)"
                  className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
                />
              </div>
            )}

            <div className="flex gap-3 items-baseline">
              <button
                onClick={save}
                disabled={saveBusy || !tokensValid}
                className="btn-ghost"
              >
                {saveBusy ? "…" : "Save & Connect"}
              </button>
            </div>
            {saveErr && (
              <p
                className="font-body italic text-[13px]"
                style={{ color: "var(--brass)" }}
              >
                {saveErr}
              </p>
            )}
          </div>
        </div>
      )}

      {card.state === "configured_starting" && (
        <div className="mt-5 flex items-baseline gap-2">
          <span
            className="font-mono text-[12px] animate-pulse"
            style={{ color: "var(--marginalia)" }}
          >
            ●
          </span>
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>
        </div>
      )}

      {card.state === "configured_running" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {card.workspace.url && (
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              <a
                href={card.workspace.url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Open workspace ↗
              </a>
            </p>
          )}

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            <button
              onClick={sendTest}
              disabled={testBusy}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Send test message"}
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect bot
            </button>
          </div>

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
        </div>
      )}

      {card.state === "error" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <div className="flex gap-3 items-baseline">
            <button onClick={() => refetch()} className="btn-ghost">
              Try again
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </ChannelCard>
  );
}

// ---------------------------------------------------------------------------
// Lane III (SMS, 2026-05-25) — SMS section inside the Phone card.
//
// Visually nested under a "SMS" SectionDivider so it co-exists with the
// existing Voice section (untouched). Mirrors the SlackCard pattern: paste
// 3 fields (Account SID + Auth Token + phone number) → Save → connected
// pill → optional allowed-users fold-out. State derivation lives in
// smsCardCore.ts; this component is the React surface + form plumbing.
// ---------------------------------------------------------------------------

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mt-6 mb-2 flex items-center gap-3">
      <span
        className="font-mono text-[10px] uppercase tracking-[0.28em] font-extrabold"
        style={{ color: "var(--brass)" }}
      >
        {label}
      </span>
      <span className="flex-1 h-px" style={{ background: "var(--rule)" }} />
    </div>
  );
}

function SmsSection() {
  const { data: statusData, refetch } = useQuery(
    getSmsChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as SmsStatus | undefined) ?? null;
  const card = deriveSmsCardState({ status });

  // Setup-state form
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [smsPhoneNumber, setSmsPhoneNumber] = useState("");
  const [smsAllowedUsers, setSmsAllowedUsers] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Test-message state.
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  // Disconnect.
  const [discBusy, setDiscBusy] = useState(false);

  const trimmedSid = accountSid.trim();
  const trimmedToken = authToken.trim();
  const trimmedNumber = smsPhoneNumber.trim();
  const sidValid = isProbablyValidTwilioAccountSid(trimmedSid);
  const tokenValid = isProbablyValidTwilioAuthToken(trimmedToken);
  const numberValid = /^\+[1-9]\d{6,14}$/.test(trimmedNumber);
  const formValid = sidValid && tokenValid && numberValid;
  const sidHint =
    trimmedSid.length > 0 && !sidValid
      ? "Account SID must look like AC + 32 hex chars."
      : null;
  const tokenHint =
    trimmedToken.length > 0 && !tokenValid
      ? "Auth token is 32 hex chars."
      : null;
  const numberHint =
    trimmedNumber.length > 0 && !numberValid
      ? "Phone number must be E.164 (e.g. +15550100)."
      : null;

  async function save() {
    if (!formValid) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      await setSmsCredentials({
        account_sid: trimmedSid,
        auth_token: trimmedToken,
        phone_number: trimmedNumber,
        allowed_users: smsAllowedUsers.trim() || undefined,
      });
      setAccountSid("");
      setAuthToken("");
      setSmsPhoneNumber("");
      setSmsAllowedUsers("");
      refetch();
    } catch (e: any) {
      setSaveErr(
        e?.message ?? e?.data?.error ?? "Couldn't save the credentials.",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function sendTest() {
    if (testBusy) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await sendSmsTest({});
      if (r?.ok) {
        setTestMsg({
          kind: "ok",
          text: r?.sid ? `Sent (sid ${r.sid}).` : "Sent — check your phone.",
        });
      } else {
        setTestMsg({
          kind: "err",
          text: r?.error ?? "Twilio refused the message.",
        });
      }
    } catch (e: any) {
      setTestMsg({
        kind: "err",
        text: e?.message ?? e?.data?.error ?? "Couldn't reach Twilio.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  async function disconnect() {
    if (discBusy) return;
    setDiscBusy(true);
    try {
      await disconnectSms({});
      refetch();
    } catch (e) {
      console.error("sms disconnect failed", e);
    } finally {
      setDiscBusy(false);
    }
  }

  return (
    <div>
      {card.state === "unconfigured" && (
        <div className="mt-3 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          <div className="space-y-2">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Twilio credentials
            </div>
            <div className="flex gap-2 items-baseline">
              <input
                type={showSecrets ? "text" : "password"}
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
                placeholder="Account SID (AC…)"
                className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => setShowSecrets((s) => !s)}
                className="btn-link"
              >
                {showSecrets ? "Hide" : "Show"}
              </button>
            </div>
            {sidHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {sidHint}
              </p>
            )}
            <input
              type={showSecrets ? "text" : "password"}
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder="Auth Token"
              className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            {tokenHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {tokenHint}
              </p>
            )}
            <input
              type="text"
              value={smsPhoneNumber}
              onChange={(e) => setSmsPhoneNumber(e.target.value)}
              placeholder="Twilio phone number (+15550100)"
              className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            />
            {numberHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {numberHint}
              </p>
            )}

            {/* Phase-2 options — allowed-users allowlist, folded by default */}
            <button
              type="button"
              onClick={() => setShowOptions((s) => !s)}
              className="btn-link text-[11px]"
            >
              {showOptions ? "Hide options" : "Options (allowed senders)"}
            </button>
            {showOptions && (
              <div className="space-y-2 border-l border-rule/40 pl-3">
                <input
                  type="text"
                  value={smsAllowedUsers}
                  onChange={(e) => setSmsAllowedUsers(e.target.value)}
                  placeholder="SMS_ALLOWED_USERS — comma-separated E.164 numbers (empty = anyone)"
                  className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
                />
              </div>
            )}

            <div className="flex gap-3 items-baseline">
              <button
                onClick={save}
                disabled={saveBusy || !formValid}
                className="btn-ghost"
              >
                {saveBusy ? "…" : "Save credentials"}
              </button>
            </div>
            {saveErr && (
              <p
                className="font-body italic text-[13px]"
                style={{ color: "var(--brass)" }}
              >
                {saveErr}
              </p>
            )}
          </div>
        </div>
      )}

      {card.state === "configured_starting" && (
        <div className="mt-3 flex items-baseline gap-2">
          <span
            className="font-mono text-[12px] animate-pulse"
            style={{ color: "var(--marginalia)" }}
          >
            ●
          </span>
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>
        </div>
      )}

      {card.state === "configured_running" && (
        <div className="mt-3 space-y-3">
          <p
            className="font-mono text-[12px]"
            style={{ color: "var(--ink)" }}
          >
            {card.heading}
          </p>
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>
          {card.accountSidMasked && (
            <p
              className="font-mono text-[11px]"
              style={{ color: "var(--marginalia)" }}
            >
              Account SID: {card.accountSidMasked}
            </p>
          )}

          {/* Allowed-senders panel — fold-out, sourced from status */}
          <div className="space-y-2 border-l border-rule/40 pl-3">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Allowed senders
            </div>
            {status?.allowed_users ? (
              <p
                className="font-mono text-[12px]"
                style={{ color: "var(--ink)" }}
              >
                {status.allowed_users}
              </p>
            ) : (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                Anyone may text {card.phoneNumber ?? "the bot"}.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            <button
              onClick={sendTest}
              disabled={testBusy}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Send test SMS"}
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect SMS
            </button>
          </div>

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
        </div>
      )}

      {card.state === "error" && (
        <div className="mt-3 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <div className="flex gap-3 items-baseline">
            <button onClick={() => refetch()} className="btn-ghost">
              Try again
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Lane III (voice, 2026-05-25) — Voice section inside the Phone card.
//
// Visually nested under a "Voice" SectionDivider below the SMS section
// (voice depends on SMS — it reuses the same Twilio credentials).
//
// The card is **read-only**: voice has no operator-facing settings of
// its own. Its job is to surface deploy-readiness — "is voice-bridge
// deployed?", "is it running with the latest creds?", "is it healthy?"
// — driven entirely by ctrl-api /api/v1/channels/voice/status (Lane I).
// State derivation lives in voiceCardCore.ts; this component is just
// the React surface that renders heading + description + pill.
// ---------------------------------------------------------------------------

function VoiceSection() {
  const { data: statusData, refetch } = useQuery(
    getVoiceChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as VoiceStatus | undefined) ?? null;
  const card = deriveVoiceCardState({ status });

  // OpenAI-key inline form. Same shape as OmiCard's needs_groq_key flow:
  // password input + Save → PATCH /admin/credentials → ctrl-api restarts
  // voice-bridge → /status flips to configured_running on next poll.
  const [openaiKey, setOpenaiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const saveOpenaiKey = useCallback(async () => {
    const v = openaiKey.trim();
    if (!v) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      const resp = await fetch("/api/v1/admin/credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ OPENAI_API_KEY: v }),
        credentials: "include",
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(
          (j as { error?: string }).error || `HTTP ${resp.status}`,
        );
      }
      setOpenaiKey("");
      // voice-bridge needs ~30s to restart with the new env; let the poll
      // catch the new state on its own cadence.
      setTimeout(() => refetch(), 2_000);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  }, [openaiKey, refetch]);

  const pillColor =
    card.pill === "active"
      ? "var(--ink)"
      : card.pill === "starting"
        ? "var(--marginalia)"
        : card.pill === "error"
          ? "var(--brass)"
          : "var(--marginalia)";

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-baseline gap-3">
        <p
          className="font-mono text-[12px]"
          style={{ color: "var(--ink)" }}
        >
          {card.heading}
        </p>
        <span
          className={
            "font-mono text-[10px] uppercase tracking-[0.22em]" +
            (card.pill === "starting" ? " animate-pulse" : "")
          }
          style={{ color: pillColor }}
        >
          {card.pill}
        </span>
      </div>

      <p
        className="font-body italic text-[13px]"
        style={{
          color: card.pill === "error" ? "var(--brass)" : "var(--marginalia)",
        }}
      >
        {card.description}
      </p>

      {card.needsOpenaiKey && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              placeholder="sk-..."
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={saveBusy}
              className="flex-1 rounded-sm border bg-transparent px-2 py-1 font-mono text-[12px]"
              style={{
                borderColor: "var(--rule)",
                color: "var(--ink)",
              }}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
              disabled={saveBusy}
            >
              {showKey ? "hide" : "show"}
            </button>
            <button
              type="button"
              onClick={saveOpenaiKey}
              disabled={saveBusy || !openaiKey.trim()}
              className="font-mono text-[10px] uppercase tracking-[0.22em] px-2 py-1 border"
              style={{
                borderColor: "var(--ink)",
                color: "var(--ink)",
                opacity: saveBusy || !openaiKey.trim() ? 0.5 : 1,
              }}
            >
              {saveBusy ? "saving..." : "save"}
            </button>
          </div>
          {saveErr && (
            <p
              className="font-mono text-[11px]"
              style={{ color: "var(--brass)" }}
            >
              {saveErr}
            </p>
          )}
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            Get a key at{" "}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
              className="underline"
              style={{ color: "var(--marginalia)" }}
            >
              platform.openai.com/api-keys
            </a>
            . After saving, the voice bridge restarts (~30s).
          </p>
        </div>
      )}

      {card.state === "configured_running" && card.callingNumber && (
        <p
          className="font-mono text-[11px]"
          style={{ color: "var(--marginalia)" }}
        >
          Calling number: {card.callingNumber}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lane III (OMI, 2026-05-25) — Phase-6b OMI channel card.
//
// State derivation lives in omiCardCore. The card has four visual states:
//   • unconfigured    → "Pair OMI first" + link to /connections.
//   • needs_groq_key  → single password-style paste box + Save.
//   • configured      → webhook URL + copy + Test pipeline + Disconnect.
//   • error           → verbatim error string + Try again.
//
// The Groq key is stored server-side in Vaultwarden via Lane I's PUT
// /api/v1/channels/omi/groq-key; alfred-learn reads it at transcription
// time. The card never reads the key back — `groq_key_present` is the
// only signal it gets.
// ---------------------------------------------------------------------------

function OmiCard() {
  const { data: statusData, refetch } = useQuery(
    getOmiChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as OmiStatus | undefined) ?? null;
  const card = deriveOmiCardState({ status });

  // Setup-state form
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Test-pipeline state.
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  // Disconnect.
  const [discBusy, setDiscBusy] = useState(false);

  // One-click webhook copy.
  const [copied, setCopied] = useState(false);

  const trimmed = apiKey.trim();
  const keyValid = isProbablyValidGroqKey(trimmed);
  const keyHint =
    trimmed.length > 0 && !keyValid
      ? "Groq keys look like gsk_… with 20+ characters."
      : null;

  async function save() {
    if (!keyValid) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      await setOmiGroqKey({ api_key: trimmed });
      setApiKey("");
      refetch();
    } catch (e: any) {
      setSaveErr(e?.message ?? e?.data?.error ?? "Couldn't save the key.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function sendTest() {
    if (testBusy) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await sendOmiTest({});
      if (r?.ok) {
        setTestMsg({
          kind: "ok",
          text:
            typeof r?.size_bytes === "number"
              ? `Sent ${r.size_bytes} bytes — check the journal.`
              : "Sent — check the journal.",
        });
      } else {
        setTestMsg({
          kind: "err",
          text: r?.error ?? "OMI test refused the chunk.",
        });
      }
    } catch (e: any) {
      setTestMsg({
        kind: "err",
        text: e?.message ?? e?.data?.error ?? "Couldn't reach the pipeline.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  async function disconnect() {
    if (discBusy) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Disconnect the Groq transcription key? OMI will keep its webhook " +
          "but audio won't be transcribed until you paste a new key.",
      )
    ) {
      return;
    }
    setDiscBusy(true);
    try {
      await disconnectOmiGroqKey({});
      refetch();
    } catch (e) {
      console.error("omi disconnect failed", e);
    } finally {
      setDiscBusy(false);
    }
  }

  function copyWebhook() {
    if (card.webhookUrl) {
      navigator.clipboard?.writeText(card.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  const address =
    card.state === "configured"
      ? "Wearable audio · transcribing"
      : card.state === "needs_groq_key"
        ? "Paired — add Groq key"
        : card.state === "error"
          ? "Needs attention"
          : "Wearable audio stream";

  return (
    <ChannelCard
      name="Omi"
      address={address}
      note="Ambient voice. Wear it; I will keep up."
      status={card.pill}
    >
      {card.state === "unconfigured" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>
          <Link to="/connections" className="btn-ghost mt-2 inline-block">
            Pair device →
          </Link>
        </div>
      )}

      {card.state === "needs_groq_key" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>
          <div className="space-y-2">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              Groq API key
            </div>
            <div className="flex gap-2 items-baseline">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="gsk_…"
                className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="btn-link"
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                onClick={save}
                disabled={saveBusy || !keyValid}
                className="btn-ghost"
              >
                {saveBusy ? "…" : "Save key"}
              </button>
            </div>
            {keyHint && (
              <p
                className="font-body italic text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {keyHint}
              </p>
            )}
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              Get a key from{" "}
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                console.groq.com/keys
              </a>
              . It lives in Vaultwarden; Alfred reads it server-side.
            </p>
            {saveErr && (
              <p
                className="font-body italic text-[13px]"
                style={{ color: "var(--brass)" }}
              >
                {saveErr}
              </p>
            )}
          </div>
        </div>
      )}

      {card.state === "configured" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {card.showWebhookBlock && card.webhookUrl && (
            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Webhook URL
              </div>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 font-mono text-[11px] border border-rule p-2 truncate"
                  style={{ color: "var(--ink)" }}
                >
                  {card.webhookUrl}
                </code>
                <button onClick={copyWebhook} className="btn-ghost">
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            <button
              onClick={sendTest}
              disabled={testBusy}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Test pipeline"}
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect transcription key
            </button>
          </div>

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
        </div>
      )}

      {card.state === "error" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <div className="flex gap-3 items-baseline">
            <button onClick={() => refetch()} className="btn-ghost">
              Try again
            </button>
            <button
              onClick={disconnect}
              disabled={discBusy}
              className="btn-link"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </ChannelCard>
  );
}
