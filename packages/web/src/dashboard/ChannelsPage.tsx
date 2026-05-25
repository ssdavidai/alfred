// ChannelsPage — live channels (#864).
//
// One card per door into Alfred. Web/email/phone/vexa/omi pull live
// data from the existing Wasp ops; Slack/Telegram are "Soon" placeholders.
// Sir #8 — also surfaces a "Terminal" card with SSH info + the
// `docker exec ... hermes` command for direct shell access.
import { useState } from "react";
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

          {/* Phone — F58/C15: BYO-number provisioning + key fix. */}
          <ChannelCard
            name="Phone"
            address={phoneNumber || "Not yet provisioned"}
            note="Call me from any number you've authorised."
            status={phoneNumber ? "active" : "available"}
          >
            {!phoneNumber && (
              <div className="mt-5 space-y-3">
                {!setupOpen ? (
                  <button
                    onClick={() => setSetupOpen(true)}
                    className="btn-ghost"
                  >
                    Set up phone →
                  </button>
                ) : (
                  <div className="space-y-3">
                    <input
                      type="password"
                      value={openaiKey}
                      onChange={(e) => setOpenaiKey(e.target.value)}
                      placeholder="OpenAI API key (sk-…)"
                      className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                    />
                    <input
                      value={twilioSid}
                      onChange={(e) => setTwilioSid(e.target.value)}
                      placeholder="Twilio Account SID (AC…)"
                      className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                    />
                    <input
                      type="password"
                      value={twilioToken}
                      onChange={(e) => setTwilioToken(e.target.value)}
                      placeholder="Twilio Auth Token"
                      className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                    />
                    <input
                      value={byoNumber}
                      onChange={(e) => setByoNumber(e.target.value)}
                      placeholder="Your Twilio number (+44 7700 900 188)"
                      className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                    />
                    <p
                      className="font-body italic text-[12px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Bring an existing Twilio number you own — purchasing new
                      numbers isn't supported yet. Inbound calling also needs
                      the voice-bridge, a separate step we're still wiring up.
                    </p>
                    <div className="flex gap-2 items-baseline">
                      <button
                        onClick={doProvisionPhone}
                        disabled={setupBusy || !setupReady}
                        className="btn-ghost"
                      >
                        {setupBusy ? "…" : "Provision"}
                      </button>
                      <button
                        onClick={() => {
                          setSetupOpen(false);
                          setSetupError(null);
                        }}
                        disabled={setupBusy}
                        className="btn-link"
                      >
                        Cancel
                      </button>
                    </div>
                    {setupError && (
                      <p
                        className="font-body italic text-[13px]"
                        style={{ color: "var(--brass)" }}
                      >
                        {setupError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            {phoneNumber && (
              <div className="mt-5 space-y-3">
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Authorised callers
                </div>
                {authorized.length === 0 ? (
                  <p
                    className="font-body italic text-[13px]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    None yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {authorized.map((n) => (
                      <li
                        key={n}
                        className="grid grid-cols-[1fr_auto] gap-3 font-mono text-[12px] items-baseline"
                      >
                        <span>{n}</span>
                        <button
                          onClick={() => removeNumber(n)}
                          disabled={phoneBusy}
                          className="btn-link"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2 items-baseline">
                  <input
                    value={newNumber}
                    onChange={(e) => setNewNumber(e.target.value)}
                    placeholder="+44 7700 900 188"
                    className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                  />
                  <button
                    onClick={addNumber}
                    disabled={phoneBusy || !newNumber.trim()}
                    className="btn-ghost"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
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

          {/* Omi — a wearable webhook stream source. F60: repointed off the
              legacy /dashboard/streams page to the canonical Connections
              surface, where the OMI catalog card + pairing modal live. */}
          <ChannelCard
            name="Omi"
            address="Wearable audio stream"
            note="Ambient voice. Wear it; I will keep up."
            status="available"
          >
            <Link to="/connections" className="btn-ghost mt-4 inline-block">
              Pair device →
            </Link>
          </ChannelCard>

          {/* Slack — native Hermes adapter */}
          <ChannelCard
            name="Slack"
            address="Native adapter"
            note="DMs and mentions, in your team's workspace."
            status="available"
          >
            <p
              className="font-body italic text-[13px] mt-4"
              style={{ color: "var(--marginalia)" }}
            >
              Built into the Hermes runtime. Add a Slack bot token to the
              Hermes config and Alfred answers in your workspace — same
              memory as the desk.
            </p>
          </ChannelCard>

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
