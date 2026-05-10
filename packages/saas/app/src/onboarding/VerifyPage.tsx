// /verify — fact verification (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/verify.tsx and wired to
// `getOnboardingProgress.key_identity_facts` + `submitFactCorrections` (the
// same shape used by DashboardPage's FactVerificationCard). Replaces the
// redesign's localStorage `getPrincipal()` Fact array with live tenant data.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useQuery,
  getOnboardingProgress,
  submitFactCorrections,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";

type FactStatus = "pending" | "confirmed" | "edited" | "discarded";
type Fact = {
  id: string;
  field: string;
  display: string;
  text: string;
  original: string;
  status: FactStatus;
};

export default function VerifyPage() {
  const navigate = useNavigate();
  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 8_000,
  });

  const sourceFacts = useMemo(() => {
    return (progress?.key_identity_facts ?? []) as Array<{
      field: string;
      value: string;
      display: string;
    }>;
  }, [progress]);

  const [facts, setFacts] = useState<Fact[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [extra, setExtra] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Hydrate the local fact list once the backend returns its first non-empty
  // payload. We don't keep re-hydrating on every refetch — the user is in the
  // middle of editing.
  useEffect(() => {
    if (seeded || sourceFacts.length === 0) return;
    setFacts(
      sourceFacts.map((f) => ({
        id: f.field,
        field: f.field,
        display: f.display,
        text: f.value,
        original: f.value,
        status: "pending" as FactStatus,
      })),
    );
    setSeeded(true);
  }, [sourceFacts, seeded]);

  const update = (id: string, patch: Partial<Fact>) => {
    setFacts((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const allTouched = facts.length > 0 && facts.every((f) => f.status !== "pending");
  const pendingCount = facts.filter((f) => f.status === "pending").length;

  const confirmAll = () => {
    setFacts((prev) =>
      prev.map((f) => (f.status === "pending" ? { ...f, status: "confirmed" } : f)),
    );
  };

  const handleContinue = async () => {
    setSubmitting(true);
    try {
      // Build corrections — same shape DashboardPage's FactVerificationCard
      // uses: { display: newValue }. Discarded entries are sent as empty
      // strings; edited entries carry their new text.
      const corrections: Record<string, string> = {};
      for (const f of facts) {
        if (f.status === "edited" && f.text !== f.original) {
          corrections[f.display] = f.text;
        } else if (f.status === "discarded") {
          corrections[f.display] = "";
        }
      }
      if (extra.trim()) {
        corrections["Anything else"] = extra.trim();
      }
      await submitFactCorrections({ corrections });
      navigate("/composing");
    } catch (err) {
      console.error("submitFactCorrections failed:", err);
      setSubmitting(false);
    }
  };

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 py-14">
        <div className="flex items-baseline justify-between gap-8 mb-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Confirm
          </div>
          <RitualNav active="verify" />
        </div>

        <h1 className="font-display text-5xl tracking-tight mb-10">
          Confirm what Alfred has learned.
        </h1>

        {!seeded && (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            A moment — Alfred is sorting his observations.
          </p>
        )}

        {seeded && pendingCount > 0 && (
          <div className="mb-6 flex justify-end">
            <button
              onClick={confirmAll}
              className="btn-ghost"
              style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
            >
              Confirm all {pendingCount} →
            </button>
          </div>
        )}

        {seeded && (
          <ol className="border-t border-rule">
            {facts.map((f, i) => {
              const isEditing = editing === f.id;
              return (
                <li
                  key={f.id}
                  className="grid grid-cols-[36px_1fr_auto] gap-4 py-5 border-b border-rule items-baseline"
                >
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {f.display}
                    </div>
                    {isEditing ? (
                      <input
                        autoFocus
                        defaultValue={f.text}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            update(f.id, {
                              text: draft || f.text,
                              status: "edited",
                            });
                            setEditing(null);
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="w-full bg-transparent outline-none border-b font-display italic text-[22px] pb-1"
                        style={{ borderColor: "var(--brass)" }}
                      />
                    ) : (
                      <div
                        className="font-body text-[19px] leading-snug"
                        style={{
                          color:
                            f.status === "discarded"
                              ? "var(--marginalia)"
                              : "var(--ink)",
                          textDecoration:
                            f.status === "discarded" ? "line-through" : "none",
                        }}
                      >
                        {f.text || "(unknown)"}
                      </div>
                    )}
                    <div
                      className="mt-2 font-mono text-[11px] uppercase tracking-[0.22em] font-extrabold"
                      style={{
                        color:
                          f.status === "pending"
                            ? "var(--marginalia)"
                            : "var(--brass)",
                      }}
                    >
                      {f.status === "pending" ? "awaiting" : f.status}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.22em] font-extrabold flex gap-2 whitespace-nowrap">
                    <button
                      onClick={() => update(f.id, { status: "confirmed" })}
                      className="btn-ghost"
                      style={
                        f.status === "confirmed"
                          ? { borderColor: "var(--brass)", color: "var(--brass)" }
                          : undefined
                      }
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => {
                        setEditing(f.id);
                        setDraft(f.text);
                      }}
                      className="btn-ghost"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => update(f.id, { status: "discarded" })}
                      className="btn-ghost"
                    >
                      Discard
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {seeded && (
          <div className="mt-12">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--marginalia)" }}
            >
              Anything else Alfred should know?
            </div>
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="A sentence will do."
              className="w-full bg-transparent outline-none border-b font-display italic text-[22px] pb-2"
              style={{ borderColor: "var(--brass)" }}
            />
          </div>
        )}

        <div className="mt-14 border-t border-rule pt-8 flex items-baseline justify-end">
          <button
            disabled={!allTouched || submitting}
            onClick={handleContinue}
            className="btn-brass"
          >
            {submitting ? "A moment…" : "Continue →"}
          </button>
        </div>
      </section>
    </Frame>
  );
}
