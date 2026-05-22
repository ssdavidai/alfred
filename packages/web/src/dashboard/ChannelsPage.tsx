// ChannelsPage — live channels (#864).
//
// One card per door into Alfred. Web/email/phone/vexa/omi pull live
// data from the existing Wasp ops; Slack/Telegram are "Soon" placeholders.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  getPhoneConfig,
  getEmailChannelStatus,
  provisionEmail,
  addAuthorizedNumber,
  removeAuthorizedNumber,
  getVexaAutoJoin,
  setVexaAutoJoin,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

// F57/C14 — the email card reads the live ctrl-api status, not a phantom
// Instance row. `inbox_address` is only present once `configured`.
interface EmailChannelStatus {
  configured: boolean;
  inbox_address: string | null;
}

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
  const email = (emailData as EmailChannelStatus | undefined) ?? {
    configured: false,
    inbox_address: null,
  };
  const phoneNumber: string = (phoneData as any)?.twilio_number ?? (phoneData as any)?.number ?? "";
  const authorized: string[] = Array.isArray((phoneData as any)?.authorized_numbers)
    ? (phoneData as any).authorized_numbers
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

          {/* Phone */}
          <ChannelCard
            name="Phone"
            address={phoneNumber || "Not yet provisioned"}
            note="Call me from any number you've authorised."
            status={phoneNumber ? "active" : "available"}
          >
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

          {/* Telegram — native Hermes adapter */}
          <ChannelCard
            name="Telegram"
            address="Native adapter"
            note="For when you're abroad."
            status="available"
          >
            <p
              className="font-body italic text-[13px] mt-4"
              style={{ color: "var(--marginalia)" }}
            >
              Built into the Hermes runtime. Pair a Telegram bot token in
              the Hermes config; first contact is confirmed by DM pairing
              on the Devices page.
            </p>
          </ChannelCard>
        </div>
      </section>
    </Frame>
  );
}

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
  status: "active" | "available" | "soon";
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-rule p-6 card-hover h-full">
      <div className="flex items-baseline justify-between mb-3">
        <span className="font-display text-3xl">{name}</span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
          style={{
            color:
              status === "active"
                ? "var(--brass)"
                : status === "soon"
                  ? "var(--marginalia)"
                  : "var(--marginalia)",
          }}
        >
          {status === "active"
            ? "Connected"
            : status === "soon"
              ? "Coming soon"
              : "Not connected"}
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
