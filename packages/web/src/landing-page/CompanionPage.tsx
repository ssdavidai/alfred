// /companion — a deliberately under-featured iOS app (#849).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/companion.tsx. Four
// phone mocks: lock screen, today, approval sheet, wallet. Static copy.
// The redesign's @/lib/alfred PRINCIPAL/TODAY constants are inlined here —
// this is marketing, not real data.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Frame } from "../client/components/ab/Frame";
import { Phone, StatusBar } from "../client/components/ab/Phone";

const PRINCIPAL = {
  name: "Edmund Vance",
  city: "London W1",
  email: "edmund@vance.london",
  phone: "+44 20 7946 0188",
};
const TODAY = "Tuesday, 12 May";

export default function CompanionPage() {
  return (
    <Frame dark>
      <section className="mx-auto max-w-[1200px] px-8 py-16">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Mobile app
        </div>
        <h1
          className="font-display text-5xl mb-14 tracking-tight"
          style={{ color: "var(--paper)" }}
        >
          Alfred on your phone.
        </h1>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 justify-items-center">
          <LockScreen />
          <Today />
          <Approval />
          <WalletCard />
        </div>
      </section>
    </Frame>
  );
}

function LockScreen() {
  return (
    <Phone label="Lock screen — the morning notification">
      <div
        className="h-full flex flex-col"
        style={{ background: "linear-gradient(180deg, #1a1a1a 0%, #0b0b0b 100%)" }}
      >
        <StatusBar />
        <div className="text-center mt-6" style={{ color: "var(--paper)" }}>
          <div className="font-mono text-[11px] uppercase tracking-[0.22em] opacity-60">
            {TODAY}
          </div>
          <div
            className="font-display text-[88px] leading-none mt-1"
            style={{ fontWeight: 300 }}
          >
            7:00
          </div>
        </div>

        <div className="mt-auto px-4 pb-32 space-y-3">
          <div
            className="rounded-[18px] px-4 py-3 backdrop-blur"
            style={{ background: "oklch(1 0 0 / 0.12)", color: "var(--paper)" }}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 grid place-items-center"
                style={{ background: "var(--brass)", borderRadius: 6 }}
              >
                <span
                  className="font-display italic text-[14px]"
                  style={{ color: "var(--wool)", fontWeight: 700 }}
                >
                  A
                </span>
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-70">
                Alfred — now
              </div>
            </div>
            <div className="font-body italic text-[15px] mt-2 leading-snug">
              Your Brief is ready. A quiet day; one matter wants your nod.
            </div>
          </div>

          <div
            className="rounded-[14px] px-4 py-3 flex items-center justify-between"
            style={{ background: "oklch(1 0 0 / 0.08)", color: "var(--paper)" }}
          >
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.22em] opacity-60">
                Emergency Identity
              </div>
              <div className="font-display text-[15px]">{PRINCIPAL.name}</div>
            </div>
            <div className="font-mono text-[10px] opacity-60">tap →</div>
          </div>
        </div>
      </div>
    </Phone>
  );
}

function Today() {
  return (
    <Phone label="The single calm surface">
      <div className="h-full paper" style={{ borderRadius: 44 }}>
        <StatusBar light={false} />
        <div className="px-8 pt-8">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            {TODAY}
          </div>
          <div className="font-display text-[34px] leading-tight mt-1">
            Good morning, sir.
          </div>
          <div
            className="font-body italic text-[15px] mt-2"
            style={{ color: "var(--marginalia)" }}
          >
            A quiet day. The Carter meeting at ten is in your inbox.
          </div>
          <hr className="rule my-6" />
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--marginalia)" }}
          >
            One matter
          </div>
          <div className="border border-rule p-4">
            <div className="font-display italic text-[18px]">
              A reply to M. Holloway.
            </div>
            <div
              className="font-body text-[14px] mt-1"
              style={{ color: "var(--marginalia)" }}
            >
              Drafted; awaiting your nod.
            </div>
            <div
              className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--brass)" }}
            >
              Read it →
            </div>
          </div>

          <div
            className="absolute bottom-10 left-0 right-0 text-center font-body italic text-[13px]"
            style={{ color: "var(--marginalia)" }}
          >
            Nothing else requires you. — A.
          </div>
        </div>
      </div>
    </Phone>
  );
}

function Approval() {
  const [state, setState] = useState<"idle" | "sent" | "held" | "speak">("idle");
  return (
    <Phone label="Approval sheet">
      <div className="h-full paper relative" style={{ borderRadius: 44 }}>
        <StatusBar light={false} />
        <div className="px-7 pt-6 pb-4">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            Draft — held for you
          </div>
          <div className="font-display italic text-[20px] mt-1">
            To Margaret Holloway
          </div>
        </div>
        <hr className="rule" />
        <div
          className="px-7 py-5 font-body text-[14px] leading-[1.55]"
          style={{ color: "var(--ink)" }}
        >
          Margaret,
          <br />
          <br />
          Thank you for your patience. The May figures are below; I have flagged
          the two that have shifted since we spoke. I am at your disposal for
          any reading you would like to do together.
          <br />
          <br />
          Yours,
          <br />
          <span className="font-display italic">Edmund Vance</span>
          <br />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            composed by Alfred
          </span>
        </div>

        {state === "idle" ? (
          <div className="absolute bottom-0 left-0 right-0 border-t border-rule grid grid-cols-3">
            {([
              ["Send", "sent"],
              ["Hold", "held"],
              ["Speak with me", "speak"],
            ] as const).map(([l, s]) => (
              <button
                key={l}
                onClick={() => setState(s)}
                className="py-4 font-mono text-[10px] uppercase tracking-[0.2em] border-r border-rule last:border-r-0"
                style={{ color: l === "Send" ? "var(--brass)" : "var(--ink)" }}
              >
                {l}
              </button>
            ))}
          </div>
        ) : (
          <div className="absolute bottom-0 left-0 right-0 border-t border-rule p-5 text-center">
            <div className="font-display italic text-[18px]">
              {state === "sent" && "Sent. Quietly."}
              {state === "held" && "Held. I shall keep it for you."}
              {state === "speak" && "Calling you now, sir."}
            </div>
            {state === "speak" ? (
              <Link
                to="/voice"
                className="font-mono text-[10px] uppercase tracking-[0.22em] mt-2 inline-block"
                style={{ color: "var(--brass)" }}
              >
                Open the call →
              </Link>
            ) : (
              <button
                onClick={() => setState("idle")}
                className="font-mono text-[10px] uppercase tracking-[0.22em] mt-2"
                style={{ color: "var(--marginalia)" }}
              >
                undo
              </button>
            )}
          </div>
        )}
      </div>
    </Phone>
  );
}

function WalletCard() {
  return (
    <Phone label="Wallet — Identity Card">
      <div className="h-full" style={{ background: "#0b0b0b", borderRadius: 44 }}>
        <StatusBar />
        <div className="px-5 pt-6 text-center" style={{ color: "var(--paper)" }}>
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] opacity-60">
            Wallet
          </div>
          <div className="font-display text-[20px] italic mt-1">
            Emergency Identity
          </div>
        </div>
        <div
          className="mx-4 mt-6 p-5"
          style={{ background: "var(--paper)", color: "var(--ink)", borderRadius: 18 }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div
                className="font-mono text-[9px] uppercase tracking-[0.24em]"
                style={{ color: "var(--brass)" }}
              >
                Principal
              </div>
              <div className="font-display text-[26px] leading-tight">
                {PRINCIPAL.name}
              </div>
              <div
                className="font-body italic text-[13px]"
                style={{ color: "var(--marginalia)" }}
              >
                Resident, {PRINCIPAL.city}
              </div>
            </div>
            <div
              className="font-display italic text-[28px]"
              style={{ color: "var(--brass)", fontWeight: 700 }}
            >
              A
            </div>
          </div>
          <hr className="rule my-4" />
          <div className="grid grid-cols-2 gap-2 font-mono text-[10px] uppercase tracking-[0.18em]">
            <div>
              <div style={{ color: "var(--marginalia)" }}>In case of</div>
              <div>illness · loss · trouble</div>
            </div>
            <div>
              <div style={{ color: "var(--marginalia)" }}>Reach</div>
              <div>{PRINCIPAL.phone}</div>
            </div>
          </div>
          <div className="rule mt-4 mb-3" />
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            The bearer is in our care. Please ring; we shall attend.
          </p>
        </div>
        <div
          className="mt-6 mx-auto"
          style={{ width: 160, height: 160, background: "var(--paper)", borderRadius: 8 }}
        >
          <Qr />
        </div>
      </div>
    </Phone>
  );
}

function Qr() {
  // A faux QR — cells of a deterministic pattern. Visual only.
  const cells = Array.from(
    { length: 13 * 13 },
    (_, i) => ((i * 53) ^ (i >> 2)) & 1,
  );
  return (
    <div
      className="grid p-2"
      style={{ gridTemplateColumns: "repeat(13, 1fr)", gap: 1 }}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          style={{
            width: "100%",
            aspectRatio: "1",
            background: c ? "var(--ink)" : "transparent",
          }}
        />
      ))}
    </div>
  );
}
