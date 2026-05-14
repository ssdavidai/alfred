// MattersPage — long-running concerns index (#859).
//
// Pulls the per-matter tally from getMattersIndex (proxies tenant ctrl-api
// /api/v1/matters). One card per matter; each card links to /matters/:id.
import { Link } from "react-router-dom";
import { useQuery, getMattersIndex } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

function fmtLast(value: string): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  } catch {
    return value;
  }
}

export default function MattersPage() {
  const { data, isLoading } = useQuery(getMattersIndex);
  const matters = data?.matters ?? [];

  return (
    <Frame>
      <section className="mx-auto max-w-[1100px] px-8 py-12">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Matters
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-12">
          Ongoing matters.
        </h1>

        {isLoading ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the file…
          </p>
        ) : matters.length === 0 ? (
          <p
            className="font-body italic text-[17px]"
            style={{ color: "var(--marginalia)" }}
          >
            Nothing yet. Every conversation, decision, and task you ask me
            to keep will gather into a matter here.
          </p>
        ) : (
          <ul className="space-y-6">
            {matters.map((m) => (
              <li key={m.id}>
                <Link
                  to={`/matters/${encodeURIComponent(m.id)}`}
                  className="block border border-rule p-6 card-hover grid grid-cols-[1fr_280px] gap-12 items-start"
                >
                  <div>
                    <h2 className="font-display text-3xl mb-2">{m.name}</h2>
                    {m.summary && (
                      <p className="font-body text-[18px] leading-[1.55] max-w-[58ch] mb-3">
                        {m.summary}
                      </p>
                    )}
                    <p
                      className="font-body italic"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Last: {fmtLast(m.last)}.
                      {m.next ? (
                        <>
                          {" "}Next:{" "}
                          <span style={{ color: "var(--ink)" }}>{m.next}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="font-mono text-[12px]">
                    {Object.entries(m.counts).map(([k, v]) => (
                      <div
                        key={k}
                        className="grid grid-cols-[1fr_auto] gap-3 py-2 border-b border-rule"
                      >
                        <span
                          className="uppercase tracking-[0.2em] text-[10px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {k}
                        </span>
                        <span style={{ color: "var(--brass)" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Frame>
  );
}
