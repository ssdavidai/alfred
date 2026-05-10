// BriefPage — the letterpress daily missive (#857).
//
// Reads today's brief from getDailyBrief (which proxies tenant ctrl-api
// /api/v1/brief/today, backed by DailyDigestWorkflow output). Renders
// it as a single envelope card; section items expand on click to show
// `reasoning` marginalia. Empty state matches the redesign's voice
// ("There is nothing to say this morning.") so a missing digest doesn't
// look like an error.
import { useState } from "react";
import { useQuery, getDailyBrief } from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { Frame } from "../client/components/ab/Frame";

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

export default function BriefPage() {
  const { data: brief, isLoading } = useQuery(getDailyBrief);
  const { data: user } = useAuth();
  const [open, setOpen] = useState<string | null>(null);

  const principalEmail =
    (user as { email?: string | null } | undefined)?.email ??
    "you@alfred.black";
  const date = brief?.date ?? new Date().toISOString().slice(0, 10);
  const subject = brief?.subject ?? "Your Brief.";
  const sections = brief?.sections ?? [];
  const smallMatter = brief?.small_matter ?? null;
  const dateline = fmtDate(date);

  return (
    <Frame>
      <section className="mx-auto max-w-[1180px] px-8 py-14">
        <article className="border border-rule">
          {/* Envelope header */}
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

          {/* The letter */}
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
                                className="text-left font-body text-[19px] leading-[1.5] hover:opacity-80"
                                style={{
                                  borderBottom: isOpen
                                    ? "1px dotted var(--brass)"
                                    : "1px dotted transparent",
                                  cursor: hasReasoning ? "pointer" : "default",
                                }}
                                aria-expanded={isOpen}
                              >
                                {it.line}
                              </button>
                              {isOpen && hasReasoning && (
                                <div
                                  className="mt-3 marginalia border-l pl-4"
                                  style={{ borderColor: "var(--brass)" }}
                                >
                                  <span
                                    className="uppercase tracking-[0.2em] mr-2"
                                    style={{ color: "var(--brass)" }}
                                  >
                                    note
                                  </span>
                                  {it.reasoning}
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

            <div className="mt-12 font-display italic text-2xl">— Alfred.</div>
          </div>
        </article>
      </section>
    </Frame>
  );
}
