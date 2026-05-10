// /awaken — first ritual step (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/awaken.tsx and wired to
// the live `getProvisioningStatus` query. Three planes (account / wire /
// household) animate in line by line at TICK ms; once the local animation has
// finished AND the backend reports the instance is running, the user advances
// to /reading-the-room.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getProvisioningStatus } from "wasp/client/operations";
import { RitualNav, HairlineFill } from "../client/components/ab/RitualNav";

const PLANES: Array<{ name: string; where: string; lines: string[] }> = [
  {
    name: "Your account",
    where: "alfred.black",
    lines: [
      "You are recognised.",
      "An account is opened.",
      "Billing is reconciled — quietly.",
    ],
  },
  {
    name: "Your private wire",
    where: "your devices",
    lines: [
      "A wire is run.",
      "Every operation gets a door.",
      "A secure mesh is laid through your devices.",
    ],
  },
  {
    name: "Your household",
    where: "your own machine",
    lines: [
      "A dedicated machine is procured for you.",
      "The volume is sealed.",
      "Your vault is composed and locked to you alone.",
      "Alfred is hired.",
    ],
  },
];

const TICK = 600;

export default function AwakenPage() {
  const [plane, setPlane] = useState(0);
  const [line, setLine] = useState(0);
  const navigate = useNavigate();

  // Poll provisioning status — until the instance is "running" we hold the
  // user on this page even after the canned animation finishes.
  const { data: provStatus } = useQuery(getProvisioningStatus, undefined, {
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (plane >= PLANES.length) return;
    const cur = PLANES[plane];
    if (line >= cur.lines.length) {
      const t = setTimeout(() => {
        setPlane(plane + 1);
        setLine(0);
      }, TICK);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setLine(line + 1), TICK);
    return () => clearTimeout(t);
  }, [plane, line]);

  const animationDone = plane >= PLANES.length;
  const instanceStatus = (provStatus?.instance?.status ?? null) as
    | string
    | null;
  const provisionDone = instanceStatus === "running";
  const done = animationDone && provisionDone;

  useEffect(() => {
    if (!done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") navigate("/reading-the-room");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [done, navigate]);

  return (
    <div className="wool min-h-screen flex flex-col">
      <header className="px-8 py-6 flex items-baseline justify-between gap-8 border-b border-rule">
        <div className="font-display text-xl tracking-tight">
          Alfred<span style={{ color: "var(--brass)" }}>·</span>Black
        </div>
        <RitualNav active="provision" />
      </header>

      <main className="flex-1 flex items-center">
        <div className="mx-auto max-w-[860px] w-full px-8">
          <h1 className="font-display text-4xl tracking-tight mb-10">
            Setting up your household.
          </h1>

          <ol className="space-y-10 mb-12">
            {PLANES.map((p, pi) => {
              const visible = pi < plane;
              const active = pi === plane;
              if (!visible && !active) return null;
              const lines = visible ? p.lines : p.lines.slice(0, line);
              return (
                <li key={p.name}>
                  <div className="flex items-baseline justify-between border-b border-rule pb-2 mb-3">
                    <span className="font-display text-2xl">{p.name}</span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.22em]"
                      style={{ color: "var(--brass)" }}
                    >
                      {p.where}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {lines.map((ln, idx) => (
                      <li
                        key={idx}
                        className="font-mono text-[14px] flex items-baseline gap-3"
                      >
                        <span style={{ color: "var(--brass)" }}>·</span>
                        <span>{ln}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>

          {!done && (
            <>
              <HairlineFill
                ms={
                  (PLANES.reduce((s, p) => s + p.lines.length, 0) +
                    PLANES.length) *
                  TICK
                }
              />
              {animationDone && !provisionDone && (
                <p
                  className="mt-6 font-body italic text-[15px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  A moment. Alfred is finishing the wiring
                  {instanceStatus ? ` (${instanceStatus})` : ""}.
                </p>
              )}
            </>
          )}

          {done && (
            <div className="mt-2">
              <button
                onClick={() => navigate("/reading-the-room")}
                className="btn-brass"
              >
                Continue →
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
