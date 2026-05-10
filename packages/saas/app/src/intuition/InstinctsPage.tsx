// InstinctsPage — patterns Alfred has learned (#860).
//
// Restyle of the legacy IntuitionPage in the redesign's "Asking /
// Confirming / Acting" three-stage idiom. Wires to the existing
// intuition operations:
//
//   getIntuitionInstincts → list of learned instincts
//   getObservations       → recent observation events (per-instinct
//                          timeline)
//   getRecentJudgments    → fed into the timeline as additional
//                          observations
//   updateInstinct        → "Forget this pattern" sets status=disabled
//   enableIntuition / disableIntuition / getIntuitionStatus
//                         → master toggle in the header
//
// Stage mapping:
//   confidence_score < 0.5  → Asking
//   0.5 ≤ confidence < 0.8  → Confirming
//   confidence ≥ 0.8        → Acting
// (When `status === "proposed"` we force Asking; `deprecated` collapses
// the row out of the index.)
import { useMemo, useState } from "react";
import {
  useQuery,
  getIntuitionInstincts,
  getIntuitionStatus,
  getObservations,
  enableIntuition,
  disableIntuition,
  updateInstinct,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

type Stage = "Asking" | "Confirming" | "Acting";
const STAGES: Stage[] = ["Asking", "Confirming", "Acting"];

function classifyStage(instinct: any): Stage {
  const status = String(instinct?.status ?? instinct?.frontmatter?.status ?? "");
  if (status === "proposed") return "Asking";
  const conf = Number(
    instinct?.frontmatter?.confidence_score ??
      instinct?.confidenceScore ??
      0,
  );
  if (Number.isFinite(conf)) {
    if (conf >= 0.8) return "Acting";
    if (conf >= 0.5) return "Confirming";
  }
  // Fallback by match count.
  const matches = Number(instinct?.matchCount ?? 0);
  if (matches >= 5) return "Acting";
  if (matches >= 2) return "Confirming";
  return "Asking";
}

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const s = String(value);
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
  } catch {
    return s;
  }
}

function fmtDateTime(value: unknown): string {
  if (!value) return "—";
  const s = String(value);
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

export default function InstinctsPage() {
  const { data: status } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const enabled =
    typeof status?.enabled === "boolean" ? status.enabled : true;

  const { data: instinctsData, refetch: refetchInstincts } = useQuery(
    getIntuitionInstincts,
    undefined,
    { refetchInterval: 60_000, retry: false },
  );
  const { data: observationsData } = useQuery(getObservations, undefined, {
    refetchInterval: 60_000,
    retry: false,
  });

  const instincts = (instinctsData?.items ?? []) as any[];
  const observations = (observationsData?.results ?? []) as any[];

  const [open, setOpen] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);

  async function toggleEnabled() {
    setToggling(true);
    try {
      if (enabled) await disableIntuition();
      else await enableIntuition();
    } catch (e) {
      console.error("toggle failed", e);
    } finally {
      setToggling(false);
    }
  }

  async function forget(instinct: any) {
    const path = String(instinct?.path ?? "");
    if (!path) return;
    setForgetting(path);
    try {
      await updateInstinct({ path, set: { status: "deprecated" } });
      await refetchInstincts();
    } catch (e) {
      console.error("forget failed", e);
    } finally {
      setForgetting(null);
    }
  }

  // Group observations by which instinct they reference. Observations
  // carry frontmatter.instinct (path) when matched.
  const observationsByInstinct = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const o of observations) {
      const ref = String(
        o?.frontmatter?.instinct ?? o?.frontmatter?.matched_instinct ?? "",
      );
      if (!ref) continue;
      (map[ref] ??= []).push(o);
    }
    return map;
  }, [observations]);

  const visible = instincts.filter((i: any) => {
    const status = String(i?.status ?? i?.frontmatter?.status ?? "");
    return status !== "deprecated";
  });

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.28em]"
              style={{ color: "var(--brass)" }}
            >
              Patterns
            </div>
            <h1 className="font-display text-5xl tracking-tight">
              Patterns Alfred has learned.
            </h1>
          </div>
          <button
            onClick={toggleEnabled}
            disabled={toggling}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: enabled ? "var(--brass)" : "var(--marginalia)" }}
          >
            {toggling
              ? "…"
              : enabled
                ? "Patterns: on"
                : "Patterns: off"}
          </button>
        </div>
        <p
          className="font-body text-[16px] max-w-[60ch] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Each pattern moves through three stages as I see it more often:
          Asking, Confirming, Acting.
        </p>

        {visible.length === 0 ? (
          <p
            className="font-body italic text-[16px] mt-10"
            style={{ color: "var(--marginalia)" }}
          >
            I haven't formed a pattern yet. They tend to gather slowly,
            from your day-to-day choices.
          </p>
        ) : (
          <ul className="border-t border-rule">
            {visible.map((p) => {
              const path = String(p?.path ?? p?.id ?? p?.name ?? "");
              const isOpen = open === path;
              const stage = classifyStage(p);
              const stageIdx = STAGES.indexOf(stage);
              const description = String(
                p?.frontmatter?.description ?? p?.description ?? "",
              ).replace(/^['"]|['"]$/g, "");
              const founded = fmtDate(
                p?.frontmatter?.created ?? p?.created ?? "",
              );
              const lastSeen = fmtDate(
                p?.frontmatter?.last_seen ?? p?.lastSeen ?? p?.updated ?? "",
              );
              const obs = observationsByInstinct[path] ?? [];
              const matches = Number(p?.matchCount ?? 0);
              return (
                <li key={path} className="border-b border-rule">
                  <button
                    onClick={() => setOpen(isOpen ? null : path)}
                    className="w-full text-left grid grid-cols-[1fr_140px_24px] gap-6 py-5 items-baseline"
                  >
                    <span className="font-display text-[22px]">
                      {p?.name ?? path}
                    </span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
                      style={{ color: "var(--brass)" }}
                    >
                      {stage}
                    </span>
                    <span style={{ color: "var(--brass)" }}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-8 pr-4 grid md:grid-cols-[1fr_320px] gap-8 items-start">
                      <div>
                        <div className="mb-5">
                          <div className="flex gap-1.5 mb-2">
                            {STAGES.map((s, i) => (
                              <div
                                key={s}
                                className="flex-1 h-[3px]"
                                style={{
                                  background:
                                    i <= stageIdx
                                      ? "var(--brass)"
                                      : "var(--rule)",
                                }}
                              />
                            ))}
                          </div>
                          <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.22em]">
                            {STAGES.map((s, i) => (
                              <span
                                key={s}
                                style={{
                                  color:
                                    i === stageIdx
                                      ? "var(--brass)"
                                      : "var(--marginalia)",
                                  fontWeight: i === stageIdx ? 800 : 400,
                                }}
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                        {description && (
                          <p
                            className="font-body text-[16px] leading-[1.6] border-l pl-4"
                            style={{ borderColor: "var(--brass)" }}
                          >
                            {description}
                          </p>
                        )}
                        <div
                          className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          since {founded} · last seen {lastSeen} · {matches}{" "}
                          matches
                        </div>
                        <div className="mt-4">
                          <button
                            onClick={() => forget(p)}
                            disabled={forgetting === path}
                            className="btn-link"
                          >
                            {forgetting === path
                              ? "Forgetting…"
                              : "Forget this pattern"}
                          </button>
                        </div>
                      </div>
                      <div>
                        <div
                          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                          style={{ color: "var(--brass)" }}
                        >
                          Observations ({obs.length})
                        </div>
                        {obs.length === 0 ? (
                          <p
                            className="font-body italic text-[14px]"
                            style={{ color: "var(--marginalia)" }}
                          >
                            No observations yet.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {obs.slice(0, 12).map((o, i) => (
                              <li
                                key={`${o?.path ?? i}`}
                                className="font-mono text-[12px] grid grid-cols-[110px_1fr] gap-3 items-baseline"
                              >
                                <span style={{ color: "var(--marginalia)" }}>
                                  {fmtDateTime(o?.frontmatter?.created)}
                                </span>
                                <span className="font-body text-[14px]">
                                  {String(
                                    o?.frontmatter?.observation ??
                                      o?.body_preview ??
                                      o?.name ??
                                      "—",
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Frame>
  );
}
