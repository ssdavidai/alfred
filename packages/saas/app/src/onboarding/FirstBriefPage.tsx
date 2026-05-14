// /first-brief — last ritual step (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/first-brief.tsx. The
// redesign hard-codes a sample BRIEF / PRINCIPAL / DATELINE; here we render
// the live tenant brief returned by `getFirstBrief` through the Markdown
// component, falling back to a quiet placeholder while the workflow
// finishes writing the vault record.
//
// On continue → /household (the editor seam from M2-D), per the redesign's
// "Confirm your household →" CTA.

import { useNavigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import { useQuery, getFirstBrief } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";
import { Markdown } from "../client/components/ab/Markdown";

function todayLong(): string {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function FirstBriefPage() {
  const navigate = useNavigate();
  const { data: user } = useAuth();
  const { data: briefData } = useQuery(getFirstBrief, undefined, {
    refetchInterval: 8_000,
  });

  const briefMarkdown = (briefData?.brief ?? null) as string | null;
  const principalName =
    user?.username ?? user?.email?.split("@")[0] ?? "Sir";
  const principalEmail = user?.email ?? "";
  const today = todayLong();

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 py-14">
        <div className="flex items-baseline justify-between gap-8 mb-8">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            First email
          </div>
          <RitualNav active="brief" />
        </div>

        <article className="border border-rule">
          <header
            className="border-b border-rule px-10 py-6 grid grid-cols-[80px_1fr] gap-y-2 gap-x-6 font-mono text-[11px] uppercase tracking-[0.18em]"
            style={{ color: "var(--marginalia)" }}
          >
            <div>From</div>
            <div>Alfred &lt;alfred@alfred.black&gt;</div>
            <div>To</div>
            <div>
              {principalName}
              {principalEmail ? ` <${principalEmail}>` : ""}
            </div>
            <div>Date</div>
            <div>{today}, 07:00</div>
            <div>Subject</div>
            <div
              className="font-body normal-case tracking-normal text-[15px]"
              style={{ color: "var(--ink)" }}
            >
              Your first Brief.
            </div>
          </header>

          <div className="px-10 md:px-16 py-14">
            {briefMarkdown ? (
              <Markdown source={briefMarkdown} />
            ) : (
              <>
                <h1 className="font-display text-5xl md:text-6xl tracking-[-0.02em] leading-[1.0]">
                  Good morning,
                </h1>
                <p
                  className="font-body italic mt-6 mb-4 text-[18px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {today}
                </p>
                <p className="font-body text-[18px] leading-[1.55] max-w-[58ch] mb-4">
                  This is the first of these. They will arrive each morning at
                  seven, on paper that does not exist and yet, I hope, feels
                  like paper.
                </p>
                <p
                  className="font-body italic text-[16px] mt-10"
                  style={{ color: "var(--marginalia)" }}
                >
                  A moment — Alfred is finishing the draft.
                </p>
              </>
            )}

            <div className="mt-12">
              <div className="font-display italic text-2xl">— Alfred.</div>
            </div>
          </div>
        </article>

        <div className="mt-12 flex items-baseline justify-end border-t border-rule pt-8">
          <button
            onClick={() => navigate("/household")}
            className="btn-brass"
          >
            Confirm your household →
          </button>
        </div>
      </section>
    </Frame>
  );
}
