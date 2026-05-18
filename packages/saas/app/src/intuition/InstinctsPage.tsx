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
  getObservationsForInstinct,
  enableIntuition,
  disableIntuition,
  updateInstinct,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

type Stage = "Asking" | "Confirming" | "Acting";
const STAGES: Stage[] = ["Asking", "Confirming", "Acting"];

// Progressive autonomy — mirrors src/matching/discretion.py exactly.
// That module is the runtime authority on whether a matched score
// passes the gate (`should_route_autonomously(score, instinct)`);
// the page just visualises the tier the user is currently in.
//
// Observations  Threshold  Butler                                 Stage
// ─────────────  ─────────  ─────────────────────────────────────  ─────────
//   < 5          0.95       "your guidance?"                       Asking
//   5–9          0.90       "rather confirm"                       Confirming
//   10–19        0.85       "fairly certain"                       Confirming
//   20–49        0.80       "handling it"                          Acting
//   50+          0.75       "automatic"                            Acting
function discretionThreshold(matchCount: number): number {
  if (matchCount < 5) return 0.95;
  if (matchCount < 10) return 0.90;
  if (matchCount < 20) return 0.85;
  if (matchCount < 50) return 0.80;
  return 0.75;
}

function effectiveThreshold(instinct: any, matchCount: number): number {
  // The runtime prefers the explicit `discretion_threshold` field
  // when set (onboarding-pipeline instincts ship with 0.92 etc.),
  // otherwise it falls back to the obs-count formula. Same here.
  const explicit = Number(
    instinct?.frontmatter?.discretion_threshold ?? NaN,
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return discretionThreshold(matchCount);
}

function butlerLine(threshold: number): string {
  if (threshold >= 0.95) return "I'd ask before acting on this.";
  if (threshold >= 0.90) return "I'd rather confirm before acting.";
  if (threshold >= 0.85) return "I'm fairly certain — quiet confirm.";
  if (threshold >= 0.80) return "I've seen this enough times to handle it.";
  return "Routine — I handle it automatically.";
}

function classifyStage(instinct: any, matchCount: number): Stage {
  const status = String(instinct?.status ?? instinct?.frontmatter?.status ?? "");
  if (status === "proposed") return "Asking";
  // Use the effective threshold the runtime actually uses (explicit
  // override OR the obs-count formula). The three buckets compress the
  // 5-tier discretion.py table by where the threshold sits, not by
  // raw obs count — that way the stage badge agrees with the butler
  // line + threshold the runtime gate enforces.
  //
  //   threshold ≥ 0.95  →  Asking
  //   0.85 ≤ thr < 0.95 →  Confirming
  //   threshold <  0.85 →  Acting
  const t = effectiveThreshold(instinct, matchCount);
  if (t >= 0.95) return "Asking";
  if (t >= 0.85) return "Confirming";
  return "Acting";
}

function titleCaseSlug(slug: string): string {
  // Strip type prefix + .md so "instinct/escalate-foo.md" → "escalate-foo".
  const base = String(slug).replace(/^[^/]*\//, "").replace(/\.md$/, "");
  if (!base) return "";
  // Title-case across kebab/underscore/dot boundaries.
  const words = base.split(/[-_.]/).filter(Boolean);
  if (words.length === 0) return base;
  // Looks-like-a-timestamp guard — don't title-case a raw 2026-05-13T...
  if (/^\d{4}/.test(words[0])) return base;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function readablePattern(p: any): string {
  // Preference order, from most-prose to least-prose:
  //   1. display_name (explicit field if author set one)
  //   2. first clause of `rule` — the freshly clustered instincts
  //      carry a real prose sentence here.
  //   3. first sentence of `description` — onboarding-pipeline
  //      instincts carry a one-line description.
  //   4. title-cased slug — only useful when the slug is descriptive
  //      like "escalate-payment-failures-and-billing".
  //   5. fallback to raw name (timestamps, hashes — rare).
  const fm = p?.frontmatter ?? {};
  const displayName = String(fm.display_name ?? "").trim();
  if (displayName) return displayName;

  const rule = String(fm.rule ?? "").trim();
  if (rule) {
    const firstClause = rule.split(/[,.]/)[0].trim();
    if (firstClause && firstClause.length <= 90) return firstClause;
    if (rule.length <= 110) return rule;
  }

  const description = String(fm.description ?? p?.description ?? "").trim();
  if (description) {
    const firstSentence = description.split(/(?<=[.!?])\s+/)[0].trim();
    if (firstSentence && firstSentence.length <= 110) return firstSentence;
  }

  const slug = String(p?.name ?? "");
  // If the slug starts with a date, fall back to sender_key or a
  // "Newly-learnt pattern" placeholder so Sir doesn't stare at
  // 2026-05-13T08-37-26Z-80199226.
  if (/^\d{4}-\d{2}-\d{2}T/.test(slug)) {
    const senderKey = String(fm.sender_key ?? "").trim();
    if (senderKey) {
      const titled =
        senderKey.charAt(0).toUpperCase() + senderKey.slice(1);
      const intent = String(fm.intent_key ?? "").trim();
      if (intent === "noise") return `Auto-suppress ${titled} as noise`;
      if (intent) return `${titled} → ${intent}`;
      return `Pattern around ${titled}`;
    }
    return "Newly-learnt pattern";
  }

  const titled = titleCaseSlug(slug);
  return titled || slug;
}

function fmtRelativeDay(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const now = new Date();
  const dayMs = 86_400_000;
  const days = Math.floor((now.getTime() - d.getTime()) / dayMs);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: now.getFullYear() === d.getFullYear() ? undefined : "2-digit",
  });
}

function observationProse(o: any): string {
  // Each observation carries a human-readable `fact` written by
  // extract_observation_from_decision / extract_obs_from_signal. That
  // is the line we want on the page — the body content
  // ("Extracted from signal `signal/...`" boilerplate) is junk for the
  // principal. Fall back through name → "—" only if the writer was
  // broken when this record was created.
  const fm = o?.frontmatter ?? {};
  const fact = String(fm.fact ?? "").trim();
  if (fact) return fact;
  const name = String(fm.name ?? o?.name ?? "").trim();
  if (name && !/^\d{4}-\d{2}-\d{2}T/.test(name)) return name;
  return "—";
}

// STORE-P3-6 adapter — the SQL `observation` table row shape
// (id, ts decimal-string ns, signal_id, instinct_id, confidence,
// embedding_id) is materially thinner than the legacy markdown record
// shape (frontmatter.fact / sender / intent / created). Render it
// gracefully: surface confidence as the badge, format ts → relative
// day, and use the signal_id as the prose line. Once signal records
// land in the SQL store (STORE-P3-3) and we have a per-signal lookup,
// we can replace the signal_id with the upstream display_headline.
function adaptSqlObservation(row: any): any {
  if (!row || typeof row !== "object") return row;
  // Legacy records carry `frontmatter.*` — those go through unchanged.
  if (row.frontmatter) return row;
  // SQL row → synthetic frontmatter shaped like the legacy renderer
  // expects. ts is a decimal nanosecond string; ÷ 1e6 → ms.
  const tsRaw = String(row.ts ?? "");
  let createdIso = "";
  if (/^-?\d+$/.test(tsRaw)) {
    try {
      const ms = Number(BigInt(tsRaw) / 1_000_000n);
      if (Number.isFinite(ms)) createdIso = new Date(ms).toISOString();
    } catch {
      /* leave blank */
    }
  }
  const conf =
    typeof row.confidence === "number"
      ? `${Math.round(row.confidence * 100)}%`
      : "";
  return {
    path: String(row.id ?? ""),
    name: String(row.id ?? ""),
    frontmatter: {
      created: createdIso,
      // Use signal_id as a stand-in for `fact`; the page's observationProse
      // falls back to name when fact is empty.
      fact: row.signal_id ? `Signal ${row.signal_id}` : "",
      source_kind: "signal",
      source_type: conf,
    },
    __sqlSourced: true,
  };
}

function ObservationRow({ obs }: { obs: any }) {
  const fm = obs?.frontmatter ?? {};
  const when = fmtRelativeDay(fm.created);
  const prose = observationProse(obs);
  const sender = String(fm.sender ?? "").trim();
  const intent = String(fm.intent ?? "").trim();
  // For decision-sourced observations, the intent IS the gesture
  // ("delegate", "noise", etc.). For signal-sourced ones the gesture
  // is "received" — already implied in the fact. Keep the metadata
  // pill thin: source-type if signal, intent if decision.
  const tag =
    String(fm.source_kind ?? "") === "decision" && intent
      ? intent
      : String(fm.source_type ?? "");
  return (
    <li className="py-3 grid grid-cols-[100px_1fr_100px] gap-4 items-baseline">
      <span
        className="font-mono text-[11px] uppercase tracking-[0.18em]"
        style={{ color: "var(--marginalia)" }}
      >
        {when}
      </span>
      <span className="font-body text-[15px] leading-[1.45]">
        {prose}
        {sender ? (
          <span
            className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: "var(--marginalia)" }}
          >
            · {sender}
          </span>
        ) : null}
      </span>
      <span
        className="font-mono text-[10px] uppercase tracking-[0.22em] text-right"
        style={{ color: "var(--brass)" }}
      >
        {tag}
      </span>
    </li>
  );
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

// STORE-P3-6: per-instinct observation feed. Fan-out one SQL query per
// expanded instinct row. The legacy `getObservations` (markdown-walking)
// stays on the page as a soak-period fallback — both feeds are merged
// with a 15-second-bucket dedupe key (mirrors P2-4's pattern), so the
// "What I've seen" panel surfaces evidence from whichever path wrote
// the record first.
function dedupeKey(obs: any): string {
  const ts = String(
    obs?.frontmatter?.created ??
      obs?.ts ??
      "",
  );
  const tsMs = Date.parse(ts);
  const bucket = Number.isFinite(tsMs) ? Math.floor(tsMs / 15_000) : ts;
  const signal =
    String(obs?.frontmatter?.signal_id ?? obs?.signal_id ?? obs?.path ?? "");
  return `${bucket}::${signal}`;
}

function InstinctObservationsPanel({
  instinctPath,
  legacyObs,
}: {
  instinctPath: string;
  legacyObs: any[];
}) {
  // SQL-backed observations for this specific instinct (STORE-P3-6).
  // The query is intentionally bounded; the page only shows the first 25.
  const { data: sqlData } = useQuery(
    getObservationsForInstinct,
    { instinctId: instinctPath, limit: 50 },
    { refetchInterval: 60_000, retry: false, enabled: Boolean(instinctPath) },
  );
  const sqlRows = useMemo(
    () => (Array.isArray(sqlData?.results) ? sqlData.results : []),
    [sqlData],
  );

  // Merge SQL + legacy, dedupe by 15-second bucket + signal id. SQL rows
  // win on collision (newer canonical store).
  const merged = useMemo(() => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const row of sqlRows) {
      const adapted = adaptSqlObservation(row);
      const k = dedupeKey(adapted);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(adapted);
    }
    for (const o of legacyObs) {
      const k = dedupeKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
    // Sort newest-first by created/ts.
    out.sort((a, b) => {
      const ta = Date.parse(String(a?.frontmatter?.created ?? "")) || 0;
      const tb = Date.parse(String(b?.frontmatter?.created ?? "")) || 0;
      return tb - ta;
    });
    return out;
  }, [sqlRows, legacyObs]);

  return (
    <div className="mt-10">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4 pb-2 border-b border-rule"
        style={{ color: "var(--brass)" }}
      >
        What I've seen ({merged.length})
      </div>
      {merged.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing matching this pattern has come through yet.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {merged.slice(0, 25).map((o, i) => (
            <ObservationRow key={`${o?.path ?? o?.id ?? i}`} obs={o} />
          ))}
          {merged.length > 25 && (
            <li
              className="pt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              · {merged.length - 25} earlier omitted
            </li>
          )}
        </ul>
      )}
    </div>
  );
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
              const obs = observationsByInstinct[path] ?? [];
              // Two distinct counts deliberately separated:
              //
              //   firedCount  — actual firings the runtime has recorded
              //                 (frontmatter.observation_count). This
              //                 is what drives the stage/threshold:
              //                 a pattern doesn't earn a higher tier
              //                 just because past events match it
              //                 retroactively.
              //   matchedSeen — observations that match the pattern
              //                 (live tally from the backfilled
              //                 `instinct:` field on observation
              //                 records). Useful evidence to show in
              //                 the panel, but not stage-determining.
              // live_observation_count is derived live by ctrl-api
              // from decision-sourced observations linked to this
              // instinct. It's the same number signal_actions reads
              // for the discretion gate — page and runtime agree.
              // Fall back to the stored snapshot for older ctrl-api
              // builds that don't enrich the response.
              const firedCount = Number(
                p?.frontmatter?.live_observation_count ??
                  p?.frontmatter?.observation_count ??
                  0,
              );
              const matchedSeen = obs.length;
              const stage = classifyStage(p, firedCount);
              const stageIdx = STAGES.indexOf(stage);
              const displayBody = String(
                p?.frontmatter?.display_body ?? "",
              ).trim();
              const description = String(
                p?.frontmatter?.description ?? p?.description ?? "",
              ).replace(/^['"]|['"]$/g, "");
              const founded = fmtDate(
                p?.frontmatter?.created ?? p?.created ?? "",
              );
              const lastSeen = fmtDate(
                p?.frontmatter?.last_seen ?? p?.lastSeen ?? p?.updated ?? "",
              );
              return (
                <li key={path} className="border-b border-rule">
                  <button
                    onClick={() => setOpen(isOpen ? null : path)}
                    className="w-full text-left grid grid-cols-[1fr_140px_24px] gap-6 py-5 items-baseline"
                  >
                    <span className="font-display text-[22px] leading-[1.25]">
                      {readablePattern(p)}
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
                    <div className="pb-10 pr-4 max-w-[760px]">
                      {/* Stage progress — single full-width band */}
                      <div className="mb-6">
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

                      {/* Body — markdown display_body if present, else
                          fall back to the plain description sentence. */}
                      {displayBody ? (
                        <div
                          className="font-body text-[16px] leading-[1.65] border-l pl-5"
                          style={{ borderColor: "var(--brass)" }}
                        >
                          <Markdown source={displayBody} useLiveResolver={false} />
                        </div>
                      ) : description ? (
                        <p
                          className="font-body text-[16px] leading-[1.65] border-l pl-5"
                          style={{ borderColor: "var(--brass)" }}
                        >
                          {description}
                        </p>
                      ) : (
                        <p
                          className="font-body italic text-[15px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          A long-form explanation hasn't been written for
                          this pattern yet.
                        </p>
                      )}

                      {/* Discretion line — the actual runtime gate
                          (mirrors should_route_autonomously in
                          src/matching/discretion.py). Threshold is
                          either the explicit instinct override or the
                          obs-count formula; whichever, that's the
                          score a match must clear to fire. */}
                      {(() => {
                        const thr = effectiveThreshold(p, firedCount);
                        return (
                          <p
                            className="mt-5 font-body italic text-[14px]"
                            style={{ color: "var(--marginalia)" }}
                          >
                            <span style={{ color: "var(--brass)" }}>
                              {butlerLine(thr)}
                            </span>{" "}
                            Fires when a match scores ≥ {thr.toFixed(2)}.
                          </p>
                        );
                      })()}

                      {/* Meta line. Show both numbers when they
                          diverge: the runtime firing count (what
                          drives autonomy) and the observed-but-not-
                          fired tally (events the pattern *would*
                          match if it were active). */}
                      <div
                        className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        since {founded} · last seen {lastSeen} ·{" "}
                        fired {firedCount} time
                        {firedCount === 1 ? "" : "s"}
                        {matchedSeen > 0 && (
                          <>
                            {" "}
                            · {matchedSeen} match
                            {matchedSeen === 1 ? "" : "es"} on record
                          </>
                        )}
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

                      {/* Observations — full-width feed, ledger-style.
                          Wired to the SQL `observation` table via
                          getObservationsForInstinct (STORE-P3-6); the
                          legacy markdown-walking observations stay merged
                          in as a soak-period fallback. */}
                      <InstinctObservationsPanel
                        instinctPath={path}
                        legacyObs={obs}
                      />
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
