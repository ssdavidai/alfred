// /preparing — interstitial between /first-brief → /household → /desk (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/preparing.tsx. Pure
// 2.4s flourish; the redesign's localStorage `updatePrincipal` write is
// dropped (everything that needs persisting is already in vault/DB).

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { RitualNav, HairlineFill } from "../client/components/ab/RitualNav";

const HOLD_MS = 2400;

export default function PreparingPage() {
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => navigate("/desk"), HOLD_MS);
    return () => clearTimeout(t);
  }, [navigate]);

  return (
    <div className="paper min-h-screen flex flex-col">
      <header className="px-8 py-6 flex items-baseline justify-between border-b border-rule">
        <div className="font-display text-xl tracking-tight">
          Alfred<span style={{ color: "var(--brass)" }}>·</span>Black
        </div>
        <RitualNav active="serve" />
      </header>
      <main className="flex-1 flex items-center">
        <div className="mx-auto max-w-[640px] w-full px-8 text-center">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-6"
            style={{ color: "var(--brass)" }}
          >
            A moment, sir
          </div>
          <h1 className="font-display italic text-5xl tracking-tight mb-10">
            Setting the table.
          </h1>
          <HairlineFill ms={HOLD_MS} />
        </div>
      </main>
    </div>
  );
}
