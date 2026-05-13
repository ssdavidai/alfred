// BriefPage — the letterpress daily missive (#857).
//
// As of STATE-MUTATION Phase E (#893) this page reads the most-recent
// briefing record written by the alfred-learn BriefingWorkflow via
// getBriefings({limit:1}). When at least one briefing exists we render
// its body through the shared Markdown component as the canonical
// surface.
//
// We keep a fallback to the legacy getDailyBrief (DailyDigestWorkflow
// output) for the short window before BriefingWorkflow has fired on a
// tenant. Phase H removes the fallback; see STATE-MUTATION.md §8.5 +
// §12 Phase H.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  getBriefings,
  getBriefing,
  getDailyBrief,
} from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

type Slot = "morning" | "evening";

interface BriefingSummary {
  slug_date: string;
  slot: Slot;
  date: string;
  composed_at: string;
}

function pickFirstBriefing(data: any): BriefingSummary | null {
  const arr: any[] = Array.isArray(data)
    ? data
    : (data?.briefings ?? data?.items ?? []);
  if (!arr.length) return null;
  const b = arr[0];
  if (!b || !b.slug_date) return null;
  return {
    slug_date: String(b.slug_date),
    slot: (b.slot === "evening" ? "evening" : "morning") as Slot,
    date: String(b.date ?? ""),
    composed_at: String(b.composed_at ?? ""),
  };
}

function fmtDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function fmtAbsolute(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

// New letterpress envelope — used when a briefing/* record exists.
function BriefingEnvelope({
  briefing,
  principalEmail,
}: {
  briefing: BriefingSummary;
  principalEmail: string;
}) {
  const { data: detail, isLoading } = useQuery(getBriefing, {
    slugDate: briefing.slug_date,
  });
  const body: string = String((detail as any)?.body ?? "");
  const slotLabel =
    briefing.slot === "morning" ? "Morning Brief" : "Evening Brief";
  const greeting =
    briefing.slot === "morning" ? "Good morning." : "Good evening.";
  const dateline = fmtDate(briefing.date || briefing.composed_at);

  return (
    <article className="border border-rule">
      <header
        className="border-b border-rule px-10 py-6 grid grid-cols-[80px_1fr] gap-y-2 gap-x-6 font-mono text-[11px] uppercase tracking-[0.18em]"
        style={{ color: "var(--marginalia)" }}
      >
        <div>From</div>
        <div>Alfred &lt;alfred@alfred.black&gt;</div>
        <div>To</div>
        <div>{principalEmail}</div>
        <div>Date</div>
        <div>{dateline}</div>
        <div>Subject</div>
        <div
          className="font-body normal-case tracking-normal text-[15px]"
          style={{ color: "var(--ink)" }}
        >
          {slotLabel}.
        </div>
      </header>

      <div className="px-10 md:px-16 py-14">
        <div className="flex items-baseline gap-4 mb-2">
          <span
            className="inline-block font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-2 border"
            style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
          >
            {slotLabel}
          </span>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            composed {fmtAbsolute(briefing.composed_at)}
          </span>
        </div>
        <h1 className="font-display text-5xl md:text-6xl tracking-[-0.02em] leading-[1.0]">
          {greeting}
        </h1>
        <p
          className="font-body italic mt-6 mb-8 text-[17px]"
          style={{ color: "var(--marginalia)" }}
        >
          {dateline}
        </p>

        <div className="rule-double mb-10" />

        {isLoading ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Composing your brief…
          </p>
        ) : !body.trim() ? (
          <p
            className="font-body italic text-[17px]"
            style={{ color: "var(--marginalia)" }}
          >
            There is nothing to say this morning. I will write again at the
            next scheduled hour.
          </p>
        ) : (
          <div className="max-w-[64ch] font-body text-[19px] leading-[1.6]">
            <Markdown source={body} useLiveResolver={false} />
          </div>
        )}

        <div className="rule mt-14 mb-8" />

        <div className="flex items-baseline justify-between">
          <div className="font-display italic text-2xl">— Alfred.</div>
          <Link
            to="/briefings"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            View all briefings →
          </Link>
        </div>
      </div>
    </article>
  );
}

// Legacy envelope — used only as a fallback when no briefing/* records
// exist yet on the tenant. Same surface as the pre-Phase-E /brief
// page, kept verbatim so the short cutover window doesn't regress
// what the principal sees. Phase H deletes this branch.
function LegacyDigestEnvelope({
  brief,
  principalEmail,
  isLoading,
}: {
  brief: any;
  principalEmail: string;
  isLoading: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const date = brief?.date ?? new Date().toISOString().slice(0, 10);
  const subject = brief?.subject ?? "Your Brief.";
  const sections: Array<{
    title: string;
    items: Array<{ id: string; line: string; reasoning: string }>;
  }> = brief?.sections ?? [];
  const smallMatter = brief?.small_matter ?? null;
  const dateline = fmtDate(date);

  return (
    <article className="border border-rule">
      <header
        className="border-b border-rule px-10 py-6 grid grid-cols-[80px_1fr] gap-y-2 gap-x-6 font-mono text-[11px] uppercase tracking-[0.18em]"
        style={{ color: "var(--marginalia)" }}
      >
        <div>From</div>
        <div>Alfred &lt;alfred@alfred.black&gt;</div>
        <div>To</div>
        <div>{principalEmail}</div>
        <div>Date</div>
        <div>{dateline}</div>
        <div>Subject</div>
        <div
          className="font-body normal-case tracking-normal text-[15px]"
          style={{ color: "var(--ink)" }}
        >
          {subject}
        </div>
      </header>

      <div className="px-10 md:px-16 py-14">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--brass)" }}
        >
          The Morning Brief
        </div>
        <h1 className="font-display text-5xl md:text-6xl tracking-[-0.02em] leading-[1.0]">
          Good morning.
        </h1>
        <p
          className="font-body italic mt-6 mb-8 text-[17px]"
          style={{ color: "var(--marginalia)" }}
        >
          {dateline}
        </p>

        <div className="rule-double mb-10" />

        {isLoading ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Composing your brief…
          </p>
        ) : sections.length === 0 ? (
          <p
            className="font-body italic text-[17px]"
            style={{ color: "var(--marginalia)" }}
          >
            There is nothing to say this morning. I will write again
            tomorrow at seven.
          </p>
        ) : (
          <div className="space-y-12">
            {sections.map((sec) => (
              <section key={sec.title}>
                <h2 className="font-display text-2xl italic mb-4">
                  {sec.title}
                </h2>
                <ul className="space-y-4">
                  {sec.items.map((it) => {
                    const isOpen = open === it.id;
                    const hasReasoning = Boolean(it.reasoning);
                    return (
                      <li
                        key={it.id}
                        className="grid grid-cols-[14px_1fr] gap-4 group"
                      >
                        <span
                          className="font-mono text-[10px] mt-2"
                          style={{ color: "var(--brass)" }}
                        >
                          §
                        </span>
                        <div>
                          <button
                            onClick={() =>
                              hasReasoning
                                ? setOpen(isOpen ? null : it.id)
                                : undefined
                            }
                            className="text-left font-body text-[19px] leading-[1.5] hover:opacity-80 [&_p]:inline [&_strong]:font-bold [&_em]:italic"
                            style={{
                              borderBottom: isOpen
                                ? "1px dotted var(--brass)"
                                : "1px dotted transparent",
                              cursor: hasReasoning ? "pointer" : "default",
                            }}
                            aria-expanded={isOpen}
                          >
                            <Markdown source={it.line} useLiveResolver={false} />
                          </button>
                          {isOpen && hasReasoning && (
                            <div
                              className="mt-3 marginalia border-l pl-4 [&_strong]:font-bold [&_em]:italic"
                              style={{ borderColor: "var(--brass)" }}
                            >
                              <span
                                className="uppercase tracking-[0.2em] mr-2"
                                style={{ color: "var(--brass)" }}
                              >
                                note
                              </span>
                              <Markdown source={it.reasoning} useLiveResolver={false} />
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <div className="rule mt-14 mb-8" />

        {smallMatter && (
          <p
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            {smallMatter}
          </p>
        )}

        <div className="flex items-baseline justify-between mt-12">
          <div className="font-display italic text-2xl">— Alfred.</div>
          <Link
            to="/briefings"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            View all briefings →
          </Link>
        </div>
      </div>
    </article>
  );
}

export default function BriefPage() {
  const { data: user } = useAuth();
  const principalEmail =
    (user as { email?: string | null } | undefined)?.email ??
    "you@alfred.black";

  // Phase E read: the newest briefing across both slots. limit=1 +
  // slot=all lets the composer pick whichever cadence is most recent
  // without the page having to guess.
  const { data: briefingsData, isLoading: briefingsLoading } = useQuery(
    getBriefings,
    { slot: "all", limit: 1 },
    { retry: false },
  );
  const latest = pickFirstBriefing(briefingsData);

  // Only fall back to the legacy digest path when we're sure there
  // are no briefings yet — i.e. the briefings query has resolved and
  // returned nothing. While the briefings query is still loading we
  // hold off on firing the fallback to avoid a double-fetch on every
  // render of /brief.
  const fallbackEnabled = !briefingsLoading && !latest;
  const { data: legacyBrief, isLoading: legacyLoading } = useQuery(
    getDailyBrief,
    undefined,
    { enabled: fallbackEnabled, retry: false },
  );

  return (
    <Frame>
      <section className="mx-auto max-w-[1180px] px-8 py-14">
        {latest ? (
          <BriefingEnvelope briefing={latest} principalEmail={principalEmail} />
        ) : (
          <LegacyDigestEnvelope
            brief={legacyBrief}
            principalEmail={principalEmail}
            isLoading={briefingsLoading || legacyLoading}
          />
        )}
      </section>
    </Frame>
  );
}
