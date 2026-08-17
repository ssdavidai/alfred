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
// Stage mapping (#447): the stage IS `frontmatter.tier` — the ladder
// Reflection writes via `apply_instinct_change` and, since #446, the field
// the signal router gates autonomous dispatch on. Read through
// `instinctTierCore.readTier`, which fails closed to Asking exactly like
// `signal_actions._instinct_tier`, so this badge cannot contradict what
// Alfred will actually do.
//
// It used to be DERIVED from confidence / observation count / threshold.
// That was defensible while the gate was threshold-only; after #446 it
// misstated autonomy in both directions (a 23-observation `Asking`
// instinct rendered as "Acting" while the router held it for Sir).
// The discretion bar is still shown — as progress toward the next
// promotion, not as the thing that names the stage.
// (`deprecated` still collapses the row out of the index.)
import { useState } from "react";
import {
  useQuery,
  getIntuitionInstincts,
  getIntuitionStatus,
  getObservations,
  enableIntuition,
  disableIntuition,
  updateInstinct,
  resolveInstinctPromotion,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

import {
  STAGES,
  autonomyStatement,
  effectiveThreshold,
  hasPendingPromotion,
  progressNote,
  readTier,
  tierCaption,
  type Stage,
} from "./instinctTierCore";
import { observationProseFromRow } from "./instinctOpsCore";

// The stage is read straight off `frontmatter.tier` (#447). The old
// derivation — `classifyStage` / `earnedCeiling` / a local
// `discretionThreshold` — is gone: it computed a stage the router did not
// use. `effectiveThreshold` survives in instinctTierCore because the
// discretion bar is still real; it just no longer names the stage.
//
// `status === "proposed"` no longer forces Asking: an unpromoted instinct
// already carries `tier: Asking`, and readTier fails closed anyway.

// Describes how well-established the pattern is — i.e. where the
// discretion BAR sits. It must NOT speak about autonomy: that is the
// tier's job (`autonomyStatement`), and the two lines render adjacently.
//
// The old copy ("Routine — I handle it automatically.") did claim
// autonomy, which after #446/#447 produced a visible contradiction on
// home: `suppress-github-paperclip-build-approval-machinery` (60
// observations, bar 0.75, tier Asking) rendered "I'll bring this to you
// and ask how to proceed." immediately above "Routine — I handle it
// automatically." A well-observed pattern is not an authorised one.
function butlerLine(threshold: number): string {
  if (threshold >= 0.95) return "Barely seen — a match would need to be near-certain.";
  if (threshold >= 0.90) return "Seen a handful of times.";
  if (threshold >= 0.85) return "Seen fairly often.";
  if (threshold >= 0.80) return "Well established by now.";
  return "Routine — seen many times over.";
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
  // Delegate to the testable core. State DB rows carry `summary`; legacy
  // vault records carry `frontmatter.fact`. Returns "" (not "—") when the
  // row has no text — ObservationRow uses this to suppress the row entirely.
  return observationProseFromRow(o);
}

function ObservationRow({ obs }: { obs: any }) {
  const prose = observationProse(obs);
  // Empty prose → render nothing. "A row whose text field is missing must
  // render as nothing, not as `undefined` or an empty bullet." (#459)
  if (!prose) return null;

  // State DB rows: created_at / ts  (vault rows: frontmatter.created)
  const fm = obs?.frontmatter ?? {};
  const when = fmtRelativeDay(obs?.created_at ?? obs?.ts ?? fm.created);
  // State DB rows: kind is the tag pill (pattern_proposal, signal, decision…)
  // Vault rows: source_kind=decision → intent; else source_type.
  const tag = obs?.kind
    ?? (String(fm.source_kind ?? "") === "decision" && String(fm.intent ?? "").trim()
        ? String(fm.intent ?? "").trim()
        : String(fm.source_type ?? ""));
  const sender = String(fm.sender ?? "").trim();
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
  const instincts = (instinctsData?.items ?? []) as any[];

  const [open, setOpen] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

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

  // Approve or decline a pending Acting promotion (#459).
  async function resolvePromotion(instinct: any, approved: boolean) {
    const instPath = String(instinct?.path ?? "");
    if (!instPath) return;
    setResolving(instPath);
    try {
      await resolveInstinctPromotion({ path: instPath, approved });
      await refetchInstincts();
      setOpen(null); // collapse so Sir sees the updated list
    } catch (e) {
      console.error("resolve promotion failed", e);
    } finally {
      setResolving(null);
    }
  }

  // Fetch observations for the currently expanded instinct card (#584).
  // Fires once per open; ?instinct=<path> filters ctrl-api to that
  // instinct_ref so the panel shows the full per-instinct slice, not a
  // truncated global top-20 that may not include older rows.
  const { data: openObsData } = useQuery(
    getObservations,
    { instinct: open ?? "" },
    { retry: false, enabled: !!open },
  );
  const openObs = ((openObsData as any)?.observations ?? []) as any[];

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
              Instincts
            </div>
            <h1 className="font-display text-5xl tracking-tight">
              Instincts Alfred has formed.
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
                ? "Instincts: on"
                : "Instincts: off"}
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
              const obs = isOpen ? openObs : [];
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
              // #447 — the ladder tier, not a confidence derivation.
              const stage = readTier(p);
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
                      {/* #459 — pending is NOT the tier; show it separately */}
                      {hasPendingPromotion(p) && (
                        <span
                          className="ml-2 font-normal text-[9px] normal-case tracking-normal"
                          style={{ color: "var(--marginalia)" }}
                        >
                          · approval pending
                        </span>
                      )}
                    </span>
                    <span style={{ color: "var(--brass)" }}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-10 pr-4 max-w-[760px]">
                      {/* Pending Acting promotion banner (#459) — above the
                          ladder. This instinct is NOT yet Acting; the tier
                          is shown correctly below. */}
                      {hasPendingPromotion(p) && (() => {
                        const fmRule = String(p?.frontmatter?.rule ?? "").trim();
                        return (
                          <div
                            className="mb-6 p-4 border-l-4"
                            style={{ borderColor: "var(--brass)" }}
                          >
                            <div
                              className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
                              style={{ color: "var(--brass)" }}
                            >
                              Approval required
                            </div>
                            <p className="font-body text-[15px] leading-[1.5] mb-2">
                              I'm proposing to reach{" "}
                              <strong>Acting</strong> for this pattern.
                              That means I will handle matches{" "}
                              <strong>on your behalf, without asking you first</strong>.
                              Currently I'm at{" "}
                              <strong>{stage}</strong> — I'll bring things
                              to you until you approve.
                            </p>
                            {fmRule && (
                              <p
                                className="font-body italic text-[14px] mb-4 leading-[1.45]"
                                style={{ color: "var(--marginalia)" }}
                              >
                                "{fmRule}"
                              </p>
                            )}
                            <div className="flex gap-3 mt-4">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  resolvePromotion(p, true);
                                }}
                                disabled={resolving === path}
                                className="font-mono text-[11px] uppercase tracking-[0.18em] px-4 py-1.5 border"
                                style={{
                                  borderColor: "var(--brass)",
                                  color: "var(--brass)",
                                }}
                              >
                                {resolving === path ? "…" : "Approve"}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  resolvePromotion(p, false);
                                }}
                                disabled={resolving === path}
                                className="font-mono text-[11px] uppercase tracking-[0.18em] px-4 py-1.5 border"
                                style={{
                                  borderColor: "var(--marginalia)",
                                  color: "var(--marginalia)",
                                }}
                              >
                                Not yet
                              </button>
                            </div>
                          </div>
                        );
                      })()}

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
                        {/* #447 — name the consequence of the current
                            rung right under the ladder, so the tier
                            reads as an autonomy setting rather than a
                            progress score. */}
                        <div
                          className="mt-2 font-mono text-[9px] uppercase tracking-[0.22em]"
                          style={{ color: "var(--brass)" }}
                        >
                          {tierCaption(stage)}
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

                      {/* Autonomy line (#447) — what the TIER means for
                          what Alfred will do unattended. This is the
                          safety statement and it comes first, because
                          it is what the router actually enforces
                          (signal_actions gates dispatch on tier: only
                          Acting may act alone).

                          The discretion bar follows, demoted to
                          evidence: it still gates *within* Acting, but
                          it no longer names the stage — promotion is
                          Reflection's call, not a threshold crossing. */}
                      {(() => {
                        const thr = effectiveThreshold(p, firedCount);
                        return (
                          <>
                            <p
                              className="mt-5 font-body text-[14px]"
                              style={{ color: "var(--marginalia)" }}
                            >
                              <span style={{ color: "var(--brass)" }}>
                                {autonomyStatement(stage)}
                              </span>{" "}
                              {progressNote(stage, firedCount)}
                            </p>
                            <p
                              className="mt-2 font-body italic text-[14px]"
                              style={{ color: "var(--marginalia)" }}
                            >
                              {butlerLine(thr)} Matches score ≥{" "}
                              {thr.toFixed(2)} to clear the discretion bar.
                            </p>
                          </>
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

                      {/* Observations — full-width feed, ledger-style */}
                      <div className="mt-10">
                        <div
                          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4 pb-2 border-b border-rule"
                          style={{ color: "var(--brass)" }}
                        >
                          What I've seen ({obs.length})
                        </div>
                        {obs.length === 0 ? (
                          <p
                            className="font-body italic text-[15px]"
                            style={{ color: "var(--marginalia)" }}
                          >
                            Nothing matching this pattern has come through yet.
                          </p>
                        ) : (
                          <ul className="divide-y divide-rule">
                            {obs.slice(0, 25).map((o, i) => (
                              <ObservationRow
                                key={`${o?.path ?? i}`}
                                obs={o}
                              />
                            ))}
                            {obs.length > 25 && (
                              <li
                                className="pt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
                                style={{ color: "var(--marginalia)" }}
                              >
                                · {obs.length - 25} earlier omitted
                              </li>
                            )}
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
