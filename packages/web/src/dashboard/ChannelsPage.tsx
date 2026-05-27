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
  listSshKeys,
  addSshKey,
  revokeSshKey,
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
  setSmsAllowlist,
  sendSmsTest,
  disconnectSms,
  getVoiceChannelStatus,
  setVoiceAllowlist,
  getOmiChannelStatus,
  setOmiGroqKey,
  disconnectOmiGroqKey,
  sendOmiTest,
  getPaperclipChannelStatus,
  sendPaperclipTest,
  setPaperclipApiKey,
  updateCredentials,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import {
  deriveTerminalCardStateV2,
  isProbablyValidPubkey,
  toKeyRows,
  type SshKeys,
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
import {
  derivePaperclipCardState,
  relativeTimeFromIso as relativeTimeFromIsoPaperclip,
  runStatusLabel as paperclipRunStatusLabel,
  truncateTaskId as truncatePaperclipTaskId,
  type PaperclipStatus,
} from "./paperclipCardCore";

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
  // (TerminalCard pulls its own data via listSshKeys — see below. Sir
  // 2026-05-26: getSshInfo is no longer the Terminal card's primary
  // source, but is kept as an exported query for any other consumers.)
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

          {/* Paperclip — P2 Lane III (2026-05-26). Hybrid integration /
              channel card: surfaces the heartbeat URL Sir pastes into
              Paperclip's HTTP adapter, plus a round-trip Test button +
              recent_runs ledger. Read-only — PAPERCLIP_API_KEY is set in
              /opt/alfred/.env by hand, the heartbeat secret is generated
              by bootstrap.sh. State derivation lives in paperclipCardCore. */}
          <PaperclipCard />

          {/* Slack — Lane III: live card backed by ctrl-api, mirror of
              TelegramCard. The four visual states + workspace info come
              from slackCardCore. */}
          <SlackCard />

          {/* Telegram — Lane III: live card backed by ctrl-api. The four
              visual states (unconfigured / configured_starting /
              configured_running / error) come from telegramCardCore. */}
          <TelegramCard />

          {/* Sir #8 — Terminal: SSH straight into the VM + `docker exec`
              into Hermes for the chattiest, lowest-latency door. Sir
              2026-05-26: card is fully self-contained — generate / paste /
              revoke keys inline, no redirect to /study. */}
          <TerminalCard />
        </div>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Sir #8 — Terminal card. Self-contained as of 2026-05-26: connect-commands
// always shown, add-key (generate or paste) + revoke-key happen inline,
// no redirect to /study. Backed by ctrl-api /api/v1/system/ssh-keys.
// State derivation lives in terminalCardCore (pure, unit-tested).
// ---------------------------------------------------------------------------

const EMPTY_SSH_KEYS: SshKeys = {
  host: "",
  port: 22,
  user: "root",
  container: "alfred-black-hermes-1",
  exec_command: "docker exec -it alfred-black-hermes-1 hermes",
  keys: [],
};

export function TerminalCard() {
  const { data: keysData, refetch } = useQuery(listSshKeys, undefined, {
    retry: false,
  });
  const data: SshKeys = (keysData as SshKeys | undefined) ?? EMPTY_SSH_KEYS;
  const view = deriveTerminalCardStateV2(data);
  const rows = toKeyRows(data.keys);

  return (
    <ChannelCard
      name="Terminal"
      address={view.sshTarget || "Connect once your VM has a domain"}
      note="The shortest path: SSH in and talk to Hermes directly."
      status={view.status}
    >
      <div className="mt-5 space-y-6">
        <CommandRow
          label="SSH in"
          command={view.sshCommand}
          hint="From your laptop, once the key below is on this VM."
        />
        <CommandRow
          label="Then talk to Alfred"
          command={view.hermesExec}
          hint="Run inside the VM — drops you into Hermes' chat REPL."
        />

        <KeyList rows={rows} onRevoke={refetch} />

        <AddKeyBlock
          keygenCommand={view.sshKeygenCommand}
          onAdded={refetch}
        />
      </div>
    </ChannelCard>
  );
}

// One-line copyable command block. Used for both SSH + docker exec.
function CommandRow({
  label,
  command,
  hint,
}: {
  label: string;
  command: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const disabled = !command;
  const copy = () => {
    if (disabled) return;
    navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--marginalia)" }}
      >
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 font-mono text-[12px] border border-rule p-2 truncate"
          style={{ color: "var(--ink)" }}
        >
          {command || "—"}
        </code>
        <button onClick={copy} disabled={disabled} className="btn-ghost">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && (
        <p
          className="font-body italic text-[11px] mt-1"
          style={{ color: "var(--marginalia)" }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

// Installed-keys list. Bootstrap rows render with a 🔒 and no Revoke.
function KeyList({
  rows,
  onRevoke,
}: {
  rows: ReturnType<typeof toKeyRows>;
  onRevoke: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doRevoke(fingerprint: string) {
    setBusy(fingerprint);
    setError(null);
    try {
      await revokeSshKey({ fingerprint });
      await onRevoke();
    } catch (e: any) {
      setError(e?.message || "Failed to revoke key");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--marginalia)" }}
      >
        Keys on this VM
      </div>
      {rows.length === 0 ? (
        <p
          className="font-body italic text-[13px]"
          style={{ color: "var(--marginalia)" }}
        >
          None yet. Add one below — generate a fresh keypair or paste your
          existing public key.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.fingerprint}
              className="grid grid-cols-[auto_1fr_auto] gap-3 items-baseline border border-rule p-2"
            >
              <span className="font-mono text-[10px]" style={{ color: "var(--marginalia)" }}>
                {r.type.replace(/^ssh-/, "")}
              </span>
              <div className="min-w-0">
                <code className="block font-mono text-[11px] truncate" style={{ color: "var(--ink)" }}>
                  {r.fingerprint}
                </code>
                <span
                  className="block font-body italic text-[11px] truncate"
                  style={{ color: "var(--marginalia)" }}
                >
                  {r.comment}
                </span>
              </div>
              {r.bootstrap ? (
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.18em]"
                  style={{ color: "var(--marginalia)" }}
                  title={r.lockReason}
                >
                  Bootstrap · locked
                </span>
              ) : (
                <button
                  onClick={() => doRevoke(r.fingerprint)}
                  disabled={busy === r.fingerprint}
                  className="btn-link"
                >
                  {busy === r.fingerprint ? "Revoking…" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p
          className="font-body italic text-[11px] mt-2"
          style={{ color: "var(--brass)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// Add-a-key block: Generate OR paste-your-own. The generate path opens
// a modal-ish reveal in-card with a one-time download of the private
// key; the paste path is plain validate + POST.
function AddKeyBlock({
  keygenCommand,
  onAdded,
}: {
  keygenCommand: string;
  onAdded: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"none" | "generate" | "paste">("none");
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [comment, setComment] = useState("");
  const [generated, setGenerated] = useState<{
    privateKey: string;
    fingerprint: string;
  } | null>(null);

  const pasteIsValid = isProbablyValidPubkey(pasted);

  async function doGenerate() {
    setBusy("generate");
    setError(null);
    try {
      const res: any = await addSshKey({
        generate: true,
        comment: comment.trim() || undefined,
      });
      if (!res?.private_key) {
        throw new Error("Server returned no private key");
      }
      setGenerated({ privateKey: res.private_key, fingerprint: res.fingerprint });
      setComment("");
      await onAdded();
    } catch (e: any) {
      setError(e?.message || "Failed to generate key");
    } finally {
      setBusy("none");
    }
  }

  async function doPaste() {
    setBusy("paste");
    setError(null);
    try {
      await addSshKey({ pubkey: pasted });
      setPasted("");
      await onAdded();
    } catch (e: any) {
      setError(e?.message || "Failed to add key");
    } finally {
      setBusy("none");
    }
  }

  // After a successful generate, show the one-time private-key reveal
  // INSTEAD of the form. The user dismisses it; we don't retain.
  if (generated) {
    return (
      <GeneratedKeyReveal
        privateKey={generated.privateKey}
        fingerprint={generated.fingerprint}
        onDismiss={() => setGenerated(null)}
      />
    );
  }

  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--marginalia)" }}
      >
        Add a key
      </div>

      {/* Generate path */}
      <div className="space-y-2 mb-4">
        <div className="flex gap-2 items-baseline">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Label (optional, e.g. 'laptop')"
            className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          />
          <button
            onClick={doGenerate}
            disabled={busy !== "none"}
            className="btn-ghost"
          >
            {busy === "generate" ? "Generating…" : "Generate new key"}
          </button>
        </div>
        <p
          className="font-body italic text-[11px]"
          style={{ color: "var(--marginalia)" }}
        >
          Creates an ed25519 keypair on this VM. You'll get one chance to
          download the private half — we don't keep it.
        </p>
      </div>

      {/* Or paste path */}
      <div
        className="font-mono text-[10px] uppercase tracking-[0.18em] mb-2 mt-4"
        style={{ color: "var(--marginalia)" }}
      >
        — or paste an existing public key —
      </div>
      <div className="space-y-2">
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="ssh-ed25519 AAAAC3Nz... user@laptop"
          rows={3}
          className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
        />
        <div className="flex items-baseline justify-between gap-2">
          <p
            className="font-body italic text-[11px]"
            style={{ color: "var(--marginalia)" }}
          >
            Or run on your laptop first:{" "}
            <code className="font-mono">{keygenCommand}</code>
          </p>
          <button
            onClick={doPaste}
            disabled={busy !== "none" || !pasted.trim() || !pasteIsValid}
            className="btn-ghost shrink-0"
          >
            {busy === "paste" ? "Adding…" : "Add this key"}
          </button>
        </div>
        {pasted.trim() && !pasteIsValid && (
          <p
            className="font-body italic text-[11px]"
            style={{ color: "var(--brass)" }}
          >
            That doesn't look like an OpenSSH public-key line.
          </p>
        )}
      </div>

      {error && (
        <p
          className="font-body italic text-[12px] mt-3"
          style={{ color: "var(--brass)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// One-time reveal of a freshly-generated private key. Dismissed → gone
// from the UI; the server never stored it. Browsers may keep the Blob
// URL in memory until the tab closes, which is acceptable here (single-
// owner VM, single-tab session).
function GeneratedKeyReveal({
  privateKey,
  fingerprint,
  onDismiss,
}: {
  privateKey: string;
  fingerprint: string;
  onDismiss: () => void;
}) {
  const href =
    typeof window !== "undefined" && typeof Blob !== "undefined"
      ? URL.createObjectURL(
          new Blob([privateKey], { type: "application/x-pem-file" }),
        )
      : "";
  const filename = `alfred-${fingerprint.replace(/^SHA256:/, "").slice(0, 10)}`;
  return (
    <div className="border border-rule p-4 space-y-3">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: "var(--brass)" }}
      >
        Your new private key — download now
      </div>
      <p
        className="font-body italic text-[12px]"
        style={{ color: "var(--marginalia)" }}
      >
        This will not be shown again. Save the file, then{" "}
        <code className="font-mono">chmod 600 ~/Downloads/{filename}</code>{" "}
        and use it with <code className="font-mono">ssh -i &lt;path&gt;</code>.
      </p>
      <pre
        className="font-mono text-[10px] border border-rule p-3 whitespace-pre-wrap break-all max-h-40 overflow-y-auto"
        style={{ color: "var(--ink)" }}
      >
        {privateKey}
      </pre>
      <div className="flex items-baseline gap-3">
        <a href={href} download={filename} className="btn-ghost">
          Download {filename}
        </a>
        <button onClick={onDismiss} className="btn-link">
          I've saved it — dismiss
        </button>
      </div>
      <p
        className="font-body text-[11px]"
        style={{ color: "var(--marginalia)" }}
      >
        Fingerprint: <code className="font-mono">{fingerprint}</code>
      </p>
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

// ---------------------------------------------------------------------------
// AllowlistEditor — shared Open / Allowlist toggle (2026-05-26).
//
// Used by both SmsSection (allowed_users) and VoiceSection (allowed_callers).
// The two channels have identical UX shape — radio toggle + CSV input — so
// they share one component. The differences are: the kind label
// ("texters" vs "callers"), the field name on the wire, and which Wasp
// action gets called on save. Everything else (E.164 hint, count line,
// save-disabled-when-empty-in-restrict-mode) is shared.
//
// Visual style matches the rest of /channels: var(--ink) / var(--marginalia)
// / var(--brass), monospace labels in uppercase letterspaced caps, italic
// body for descriptive lines.
// ---------------------------------------------------------------------------

interface AllowlistEditorProps {
  /** Initial state from /status — "" means no allowlist saved yet. */
  initialAllowAll: boolean;
  initialEntries: string;
  /** Singular subject ("texter" / "caller") used in the muted-italic copy. */
  subjectSingular: string;
  /** Verb used in the muted-italic open-mode line ("text" / "call"). */
  verbOpen: string;
  /** Async save callback — receives the final shape; the editor handles UI state. */
  onSave: (next: {
    allow_all: boolean;
    entries: string;
  }) => Promise<unknown>;
}

function AllowlistEditor({
  initialAllowAll,
  initialEntries,
  subjectSingular,
  verbOpen,
  onSave,
}: AllowlistEditorProps) {
  // The radio's source of truth is local state, seeded from status. We
  // intentionally do NOT keep this in sync with status after first mount —
  // mid-edit, the operator's choice wins until they hit Save.
  const [mode, setMode] = useState<"open" | "allowlist">(
    initialAllowAll ? "open" : "allowlist",
  );
  const [entries, setEntries] = useState<string>(initialEntries);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const trimmed = entries.trim();
  const count = trimmed
    ? trimmed
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean).length
    : 0;
  const canSave =
    !busy && (mode === "open" || (mode === "allowlist" && count > 0));

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        allow_all: mode === "open",
        entries: mode === "open" ? "" : trimmed,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (e: any) {
      setErr(
        e?.message ??
          e?.data?.error ??
          "Couldn't save the allowlist. Check the format and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-l border-rule/40 pl-3">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: "var(--marginalia)" }}
      >
        Who can {verbOpen} Alfred
      </div>

      {/* Radio toggle — two mutually exclusive modes. */}
      <div className="flex flex-wrap gap-4 items-baseline">
        <label className="flex items-baseline gap-2 cursor-pointer">
          <input
            type="radio"
            name={`allowlist-mode-${subjectSingular}`}
            checked={mode === "open"}
            onChange={() => setMode("open")}
            disabled={busy}
          />
          <span
            className="font-mono text-[12px]"
            style={{ color: "var(--ink)" }}
          >
            Open
          </span>
        </label>
        <label className="flex items-baseline gap-2 cursor-pointer">
          <input
            type="radio"
            name={`allowlist-mode-${subjectSingular}`}
            checked={mode === "allowlist"}
            onChange={() => setMode("allowlist")}
            disabled={busy}
          />
          <span
            className="font-mono text-[12px]"
            style={{ color: "var(--ink)" }}
          >
            Allowlist
          </span>
        </label>
      </div>

      {/* Status line — what the persisted state says, before the editor. */}
      {mode === "open" ? (
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          Open — anyone can {verbOpen} Alfred.
        </p>
      ) : (
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          {count === 0
            ? `No ${subjectSingular}s yet — paste E.164 numbers below.`
            : `Allowlist: ${count} ${subjectSingular}${count === 1 ? "" : "s"}.`}
        </p>
      )}

      <input
        type="text"
        value={entries}
        onChange={(e) => setEntries(e.target.value)}
        placeholder="+15551234567, +442345..."
        disabled={mode === "open" || busy}
        className="w-full bg-transparent border px-2 py-1 font-mono text-[11px]"
        style={{
          borderColor: "var(--rule)",
          color: "var(--ink)",
          opacity: mode === "open" ? 0.4 : 1,
        }}
      />

      <div className="flex flex-wrap gap-3 items-baseline">
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="font-mono text-[10px] uppercase tracking-[0.22em] px-2 py-1 border"
          style={{
            borderColor: "var(--ink)",
            color: "var(--ink)",
            opacity: canSave ? 1 : 0.5,
          }}
        >
          {busy ? "saving..." : "save"}
        </button>
        {savedFlash && (
          <span
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            ✓ Saved.
          </span>
        )}
      </div>

      {err && (
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--brass)" }}
        >
          {err}
        </p>
      )}
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

          {/* Allowlist editor — Open / Allowlist toggle backed by
              setSmsAllowlist (2026-05-26). Re-mounts on status change so
              the initial seed is always the persisted server state. */}
          <AllowlistEditor
            key={`sms-${status?.allow_all ? "open" : "list"}-${status?.allowed_users ?? ""}`}
            initialAllowAll={status?.allow_all ?? true}
            initialEntries={status?.allowed_users ?? ""}
            subjectSingular="texter"
            verbOpen="text"
            onSave={async ({ allow_all, entries }) => {
              await setSmsAllowlist({
                allow_all,
                allowed_users: entries,
              });
              refetch();
            }}
          />

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
      // Use the Wasp action — it proxies through the server's tenantProxy
      // with the master AAS_API_KEY. A raw fetch to `/api/v1/admin/credentials`
      // from the browser lands on the SPA nginx (no API server in front of it
      // on alfred-black), which returns 405. The action surface is the only
      // working path from the dashboard.
      await updateCredentials({ OPENAI_API_KEY: v });
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

      {/* Allowlist editor — show as long as voice is past the unconfigured
          stage (i.e. compose service exists + SMS creds are set). We render
          it even in needs-openai-key state so the operator can lock down
          the bridge before pasting the key. */}
      {card.state !== "unconfigured" && (
        <AllowlistEditor
          key={`voice-${status?.allow_all ? "open" : "list"}-${status?.allowed_callers ?? ""}`}
          initialAllowAll={status?.allow_all ?? true}
          initialEntries={status?.allowed_callers ?? ""}
          subjectSingular="caller"
          verbOpen="call"
          onSave={async ({ allow_all, entries }) => {
            await setVoiceAllowlist({
              allow_all,
              allowed_callers: entries,
            });
            refetch();
          }}
        />
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

// ---------------------------------------------------------------------------
// Paperclip card — P2 Lane III (2026-05-26).
//
// Hybrid card: BOTH an integration (Paperclip is the managed-employee
// platform Alfred runs inside, deep-link to paperclip.<DOMAIN>) AND a
// channel (heartbeats flow inbound, Hermes responds).
//
// Three visual states (derivation in paperclipCardCore.ts):
//   • missing_secret — bootstrap.sh hasn't generated the heartbeat
//                      secret. Warning copy, Test disabled.
//   • awaiting       — secret set, no heartbeat yet. Webhook URL is the
//                      hero — operator pastes it into Paperclip's HTTP
//                      adapter. Deep-link button to paperclip.<DOMAIN>.
//   • connected      — heartbeats flowing. Pill = "Connected", last seen
//                      relative time, recent_runs ledger (top 5,
//                      expandable to 10), webhook URL collapsed behind
//                      a "Reveal webhook URL" disclosure.
//
// Read-only card except for the Test button. There is NO setter op:
// PAPERCLIP_API_KEY (outbound) is pasted into /opt/alfred/.env by hand;
// PAPERCLIP_HEARTBEAT_SECRET is auto-generated by bootstrap.sh.
// ---------------------------------------------------------------------------

function PaperclipCard() {
  const { data: statusData, refetch } = useQuery(
    getPaperclipChannelStatus,
    undefined,
    { retry: false },
  );
  const status = (statusData as PaperclipStatus | undefined) ?? null;
  const card = derivePaperclipCardState(status);

  // Round-trip Test state — toast-style "✓ <latency> · <sample>" line.
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  // One-click webhook copy.
  const [copied, setCopied] = useState(false);

  // "Reveal webhook URL" disclosure (collapsed by default in connected state).
  const [webhookRevealed, setWebhookRevealed] = useState(false);

  // "Show all" toggle for recent_runs (collapsed: 5, expanded: up to 10).
  const [runsExpanded, setRunsExpanded] = useState(false);

  function copyWebhook() {
    if (card.heartbeatUrl) {
      navigator.clipboard?.writeText(card.heartbeatUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  async function sendTest() {
    if (testBusy || !card.canTest) return;
    setTestBusy(true);
    setTestMsg(null);
    try {
      const r: any = await sendPaperclipTest({});
      if (r?.ok) {
        const lat =
          typeof r?.latency_ms === "number" ? `${r.latency_ms} ms` : "ok";
        const sample =
          typeof r?.sample_response === "string" && r.sample_response
            ? ` · ${r.sample_response}`
            : "";
        setTestMsg({ kind: "ok", text: `Round-trip ${lat}${sample}` });
      } else {
        const reason =
          (typeof r?.sample_response === "string" && r.sample_response) ||
          (typeof r?.status === "number" ? `HTTP ${r.status}` : null) ||
          "Paperclip refused the heartbeat.";
        setTestMsg({ kind: "err", text: reason });
      }
      refetch();
    } catch (e: any) {
      setTestMsg({
        kind: "err",
        text:
          e?.message ?? e?.data?.error ?? "Couldn't reach the heartbeat endpoint.",
      });
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(null), 6000);
    }
  }

  const address =
    card.status === "connected"
      ? card.lastHeartbeatRelative
        ? `Last heartbeat ${card.lastHeartbeatRelative}`
        : "Receiving tasks"
      : card.status === "awaiting"
        ? "Paperclip employee — awaiting first task"
        : "Setup required";

  const runsToShow = runsExpanded ? card.allRuns : card.visibleRuns;

  return (
    <ChannelCard
      name="Paperclip"
      address={address}
      note="Where Alfred works as a managed employee — paperclip.ing."
      status={card.pillTone}
    >
      {/* missing_secret — bootstrap.sh hasn't generated the heartbeat
          secret yet. Surface the runbook hint; Test disabled. */}
      {card.status === "missing_secret" && (
        <div className="mt-5 space-y-3">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--brass)" }}
          >
            {card.description}
          </p>
          <div className="flex gap-3 items-baseline">
            <button onClick={() => refetch()} className="btn-ghost">
              Re-check
            </button>
            <button
              type="button"
              disabled
              className="btn-ghost opacity-50 cursor-not-allowed"
              title="Run bootstrap.sh first to generate the heartbeat secret."
            >
              Send test heartbeat
            </button>
          </div>
        </div>
      )}

      {/* needs_admin_signup — paperclip-init has captured the CEO invite
          URL but no admin has signed up yet. The principal clicks the
          big "Set up your Paperclip account →" button (opens new tab),
          completes Paperclip's first-run signup, comes back; the next
          /status poll flips to "needs_api_key" and the panel below
          takes over. Replaces the 6-step manual SSH ritual (2026-05-27). */}
      {card.status === "needs_admin_signup" && (
        <PaperclipAdminSignupPanel
          adminInviteUrl={card.adminInviteUrl}
          paperclipOrigin={card.paperclipOrigin}
          description={card.description}
          onRefetch={refetch}
        />
      )}

      {/* needs_api_key — Paperclip is up but the principal hasn't walked
          its own setup ritual yet (P3). Two-click path: "Open Paperclip"
          → they sign up + generate an API key → paste here. Once the
          key validates, the card flips to "awaiting". */}
      {card.status === "needs_api_key" && (
        <PaperclipApiKeyPanel
          paperclipOrigin={card.paperclipOrigin}
          isReauth={card.pillLabel === "Key rejected"}
          description={card.description}
          onSaved={refetch}
        />
      )}

      {/* awaiting — secret set, no heartbeat yet. The webhook URL is the
          hero artifact: Sir pastes it into Paperclip's HTTP-adapter UI
          when creating the Alfred employee. */}
      {card.status === "awaiting" && (
        <div className="mt-5 space-y-4">
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
              Webhook URL (paste into Paperclip's HTTP adapter)
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 font-mono text-[11px] border border-rule p-2 truncate"
                style={{ color: "var(--ink)" }}
              >
                {card.heartbeatUrl || "—"}
              </code>
              <button
                onClick={copyWebhook}
                disabled={!card.heartbeatUrl}
                className="btn-ghost"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p
              className="font-body italic text-[12px]"
              style={{ color: "var(--marginalia)" }}
            >
              In Paperclip: Settings → Agents → New → adapterType{" "}
              <code>http</code>, webhookUrl above.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            {card.paperclipOrigin && (
              <a
                href={card.paperclipOrigin}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost"
              >
                Open Paperclip →
              </a>
            )}
            <button
              onClick={sendTest}
              disabled={testBusy || !card.canTest}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Send test heartbeat"}
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

      {/* connected — heartbeats flowing. recent_runs ledger is the body;
          webhook URL collapsed behind a disclosure, Test always enabled. */}
      {card.status === "connected" && (
        <div className="mt-5 space-y-4">
          <p
            className="font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            {card.description}
          </p>

          {runsToShow.length > 0 && (
            <div className="space-y-2">
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Recent tasks
              </div>
              <ul className="space-y-1">
                {runsToShow.map((r) => {
                  const isOk = r.status === "ok";
                  const isReplay = r.status === "replay";
                  const dotColor =
                    isOk || isReplay ? "var(--marginalia)" : "var(--brass)";
                  const when = r.ts
                    ? relativeTimeFromIsoPaperclip(r.ts)
                    : "—";
                  return (
                    <li
                      key={r.run_id || `${r.task_id}-${r.ts}`}
                      className="flex items-baseline gap-3 border-b border-rule/40 pb-1"
                    >
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: dotColor }}
                        title={paperclipRunStatusLabel(r.status)}
                      >
                        ●
                      </span>
                      <span
                        className="flex-1 font-mono text-[11px]"
                        style={{ color: "var(--ink)" }}
                      >
                        {truncatePaperclipTaskId(r.task_id) || "—"}
                      </span>
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {paperclipRunStatusLabel(r.status)}
                      </span>
                      <span
                        className="font-mono text-[10px] tabular-nums"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {r.duration_ms}ms
                      </span>
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {when}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {card.hasMoreRuns && !runsExpanded && (
                <button
                  type="button"
                  onClick={() => setRunsExpanded(true)}
                  className="btn-link text-[11px]"
                >
                  Show all
                </button>
              )}
              {runsExpanded && (
                <button
                  type="button"
                  onClick={() => setRunsExpanded(false)}
                  className="btn-link text-[11px]"
                >
                  Show fewer
                </button>
              )}
            </div>
          )}

          {/* Webhook URL collapsed-by-default once connected — no operator
              wants to re-paste a URL they already pasted. */}
          <div className="space-y-2">
            {!webhookRevealed && (
              <button
                type="button"
                onClick={() => setWebhookRevealed(true)}
                className="btn-link text-[11px]"
              >
                Reveal webhook URL
              </button>
            )}
            {webhookRevealed && (
              <>
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
                    {card.heartbeatUrl}
                  </code>
                  <button
                    onClick={copyWebhook}
                    disabled={!card.heartbeatUrl}
                    className="btn-ghost"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setWebhookRevealed(false)}
                    className="btn-link text-[11px]"
                  >
                    Hide
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-3 items-baseline pt-1">
            {card.paperclipOrigin && (
              <a
                href={card.paperclipOrigin}
                target="_blank"
                rel="noreferrer"
                className="btn-link"
              >
                Open Paperclip →
              </a>
            )}
            <button
              onClick={sendTest}
              disabled={testBusy || !card.canTest}
              className="btn-ghost"
            >
              {testBusy ? "…" : "Send test heartbeat"}
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
    </ChannelCard>
  );
}

// ---------------------------------------------------------------------------
// Paperclip admin-signup click-through panel (2026-05-27).
//
// Rendered when card.status === "needs_admin_signup". The paperclip-init
// compose service runs `pnpm paperclipai onboard` + `pnpm paperclipai auth
// bootstrap-ceo` automatically on first boot and writes the captured
// "Invite URL: …" to /alfred-data/paperclip-ceo-invite.txt. ctrl-api reads
// that file and surfaces it as `admin_invite_url`. The principal:
//
//   1. Clicks the big "Set up your Paperclip account →" button (new tab).
//   2. Signs up in Paperclip's normal first-run flow (claim instance,
//      pick a password).
//   3. Comes back to this card; the next /status poll flips to
//      "needs_api_key" and the PaperclipApiKeyPanel below carries them
//      through generating + pasting an API key.
//
// Zero CLI. Replaces the 6-step SSH ritual Sir walked through on home.
//
// Edge case — invite URL not yet present (paperclip-init still running on
// a freshly-deployed tenant): we render a "preparing your invite…"
// placeholder + a Re-check button so the principal can poll. Once
// adminInviteUrl arrives, the click-through CTA appears.
// ---------------------------------------------------------------------------

function PaperclipAdminSignupPanel({
  adminInviteUrl,
  paperclipOrigin,
  description,
  onRefetch,
}: {
  adminInviteUrl: string;
  paperclipOrigin: string;
  description: string;
  onRefetch: () => unknown;
}) {
  const ready = Boolean(adminInviteUrl);
  return (
    <div className="mt-5 space-y-5">
      <p
        className="font-body italic text-[13px]"
        style={{ color: "var(--marginalia)" }}
      >
        {description}
      </p>

      {ready ? (
        <a
          href={adminInviteUrl}
          target="_blank"
          rel="noopener noreferrer"
          // Mirror PaperclipApiKeyPanel's button class so the visual
          // language is identical — same fonts, same hover, same height.
          className="btn-ghost inline-block"
        >
          Set up your Paperclip account →
        </a>
      ) : (
        <div className="space-y-2">
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--brass)" }}
          >
            Preparing your invite — this usually takes about 30 seconds after
            the Paperclip container boots.
          </p>
          <button
            type="button"
            onClick={() => onRefetch()}
            className="btn-ghost"
          >
            Re-check
          </button>
        </div>
      )}

      <p
        className="font-body italic text-[11px]"
        style={{ color: "var(--marginalia)" }}
      >
        After you sign up, come back here and the card will move you to the
        next step (paste an API key from Paperclip → Settings → API keys).
      </p>

      {/* Secondary deep-link, kept available in case the invite link
          expires and the principal needs to start over via Paperclip's
          /sign-in page. Mirrors the same "Open Paperclip →" affordance
          PaperclipApiKeyPanel ships. */}
      {paperclipOrigin && (
        <a
          href={paperclipOrigin}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] uppercase tracking-[0.22em] underline"
          style={{ color: "var(--marginalia)" }}
        >
          Open Paperclip directly →
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// P3 — Paperclip API-key paste panel.
//
// Rendered when card.status === "needs_api_key". Paperclip's API-key
// issuance is gated by their better-auth UI, so we can't auto-bootstrap
// that step. The card guides the principal:
//
//   1. They've already signed up via the needs_admin_signup CTA above.
//   2. Inside Paperclip: Settings → API keys → Generate.
//   3. Paste it back here; ctrl-api validates round-trip, writes
//      PAPERCLIP_API_KEY into /opt/alfred/.env + the hermes profile's
//      .env, and kicks hermes-main so the MCP server picks it up.
//
// On success the card auto-flips to "awaiting" (heartbeat URL ready to
// paste into Paperclip's HTTP-adapter agent setup). Same one-time-paste
// UX as the SSH-key "generate + download" panel.
// ---------------------------------------------------------------------------

function PaperclipApiKeyPanel({
  paperclipOrigin,
  isReauth,
  description,
  onSaved,
}: {
  paperclipOrigin: string;
  isReauth: boolean;
  description: string;
  onSaved: () => Promise<unknown>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const r: any = await setPaperclipApiKey({ api_key: trimmed });
      if (r?.ok) {
        setApiKey("");
        await onSaved();
      } else {
        setError("Paperclip didn't accept that key. Try generating a fresh one.");
      }
    } catch (e: any) {
      setError(e?.message ?? "Couldn't save the key. Check the ctrl-api logs.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 space-y-5">
      <p
        className="font-body italic text-[13px]"
        style={{ color: isReauth ? "var(--brass)" : "var(--marginalia)" }}
      >
        {description}
      </p>

      {!isReauth && (
        <ol
          className="space-y-2 font-body text-[13px]"
          style={{ color: "var(--ink)" }}
        >
          <li>
            <span style={{ color: "var(--marginalia)" }}>1.</span>{" "}
            Open Paperclip and finish its first-run setup (sign up, claim
            the instance).
          </li>
          <li>
            <span style={{ color: "var(--marginalia)" }}>2.</span>{" "}
            Inside Paperclip: <code className="font-mono">Settings →
            API keys → Generate</code>.
          </li>
          <li>
            <span style={{ color: "var(--marginalia)" }}>3.</span>{" "}
            Paste the generated key below. Alfred takes it from there.
          </li>
        </ol>
      )}

      {paperclipOrigin && (
        <a
          href={paperclipOrigin}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost inline-block"
        >
          Open Paperclip →
        </a>
      )}

      <div className="space-y-2">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Paste API key
        </div>
        <textarea
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="pck_… (from Paperclip Settings → API keys)"
          rows={2}
          className="w-full bg-transparent border border-rule px-2 py-1 font-mono text-[11px]"
        />
        <div className="flex items-baseline justify-between gap-2">
          <p
            className="font-body italic text-[11px]"
            style={{ color: "var(--marginalia)" }}
          >
            Alfred validates the key against Paperclip and only persists it
            if it works.
          </p>
          <button
            onClick={save}
            disabled={busy || !apiKey.trim()}
            className="btn-ghost shrink-0"
          >
            {busy ? "Validating…" : isReauth ? "Update key" : "Save & connect"}
          </button>
        </div>
        {error && (
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--brass)" }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
