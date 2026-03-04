import { useEffect, useRef } from "react";

const browserTabs = [
  { label: "Slack — #general", active: false },
  { label: "Gmail — Inbox (47)", active: false },
  { label: "Google Calendar", active: true },
  { label: "Notion — Q3 Plan…", active: false },
  { label: "Sheets — Budget…", active: false },
  { label: "Zoom — Meeting…", active: false },
  { label: "Figma — Landing…", active: false },
  { label: "Jira — PROJ-847", active: false },
  { label: "Drive — Shared", active: false },
  { label: "WhatsApp Web", active: false },
  { label: "ChatGPT", active: false },
  { label: "Teams — Stand…", active: false },
  { label: "Salesforce — Da…", active: false },
  { label: "HubSpot — Con…", active: false },
  { label: "Linear — ISS-23…", active: false },
  { label: "Discord — #dev", active: false },
  { label: "Twitter / X", active: false },
  { label: "Docs — Propos…", active: false },
  { label: "GitHub — PR #4…", active: false },
  { label: "Stripe — Dashb…", active: false },
  { label: "AWS Console", active: false },
  { label: "Vercel — Deploy…", active: false },
  { label: "1Password", active: false },
  { label: "+12", active: false },
];

const equivalencies = [
  { number: "50", unit: "full-length movies" },
  { number: "50,000", unit: "photos" },
  { number: "200,000", unit: "hours of voice calls" },
  { number: "3 million", unit: "emails" },
  { number: "150", unit: "hours of Zoom recordings" },
];

export default function Overwhelm() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".reveal").forEach((el, i) => {
              setTimeout(() => el.classList.add("visible"), i * 120);
            });
          }
        });
      },
      { threshold: 0.1 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="bg-cream px-6 py-32 text-[#1A1A1A] lg:py-40"
    >
      <div className="mx-auto max-w-[900px]">
        <p className="reveal font-mono text-sm font-light uppercase tracking-[0.45em] text-gold">
          THE PROBLEM
        </p>

        <h2 className="reveal mt-12 font-serif text-4xl leading-[1.2] text-[#1A1A1A] md:text-5xl">
          Your brain has too many tabs open.
        </h2>

        {/* Simulated browser tab bar */}
        <div className="reveal mt-10 overflow-hidden rounded-t-lg border border-[#1A1A1A]/10 bg-[#1A1A1A]/[0.03]">
          {/* Tab bar */}
          <div className="flex overflow-hidden bg-[#D8D4CE]">
            {browserTabs.map((tab) => (
              <div
                key={tab.label}
                className={`flex min-w-0 shrink-0 items-center gap-1.5 border-r border-[#1A1A1A]/[0.06] px-3 py-2 ${
                  tab.active
                    ? "bg-[#F5F1EB]"
                    : "bg-[#D8D4CE]"
                }`}
                style={{ maxWidth: "140px" }}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1A1A1A]/15" />
                <span className="truncate font-sans text-[10px] text-[#1A1A1A]/50">
                  {tab.label}
                </span>
                <span className="ml-auto shrink-0 font-sans text-[9px] text-[#1A1A1A]/20">
                  ×
                </span>
              </div>
            ))}
          </div>
          {/* Address bar */}
          <div className="flex items-center gap-3 bg-[#F5F1EB] px-4 py-2">
            <div className="flex gap-1.5">
              <span className="text-[#1A1A1A]/20">←</span>
              <span className="text-[#1A1A1A]/20">→</span>
              <span className="text-[#1A1A1A]/20">↻</span>
            </div>
            <div className="flex-1 rounded bg-[#E8E4DE] px-3 py-1">
              <span className="font-mono text-[10px] text-[#1A1A1A]/30">
                calendar.google.com/calendar/u/0/r/week/2026/2/27
              </span>
            </div>
          </div>
        </div>

        <p className="reveal mt-14 font-serif text-2xl font-light leading-[1.7] text-[#1A1A1A]/80 md:text-3xl">
          The average knowledge worker switches between apps{" "}
          <span className="font-normal text-[#1A1A1A]">
            over 30 times per hour
          </span>
          , overwhelming your brain with{" "}
          <span className="font-normal text-[#1A1A1A]">
            over 100 gigabytes
          </span>{" "}
          of contextual junk every single day.
        </p>

        <p className="reveal mt-10 font-serif text-2xl font-light leading-[1.7] text-[#1A1A1A]/80 md:text-3xl">
          That's the equivalent of downloading:
        </p>

        <div className="reveal mt-8 space-y-4">
          {equivalencies.map((eq) => (
            <div key={eq.unit} className="flex items-baseline gap-4">
              <span className="font-serif text-3xl font-light text-gold md:text-4xl">
                {eq.number}
              </span>
              <span className="font-mono text-sm font-light uppercase tracking-wider text-[#8A8680]">
                {eq.unit}
              </span>
            </div>
          ))}
          <div className="flex items-baseline gap-4 pt-2">
            <span className="font-serif text-2xl font-light italic text-[#1A1A1A]">
              Every. Single. Day.
            </span>
          </div>
        </div>

        <div className="reveal mt-14 space-y-8">
          <p className="font-serif text-2xl font-light leading-[1.8] text-[#1A1A1A]/80">
            This is why you're overwhelmed. You're suffering from{" "}
            <a
              href="https://www.sciencedirect.com/book/monograph/9781843344490/information-obesity"
              target="_blank"
              rel="noopener noreferrer"
              className="font-normal text-[#1A1A1A] underline decoration-gold/40 underline-offset-4 transition-colors hover:text-gold"
            >
              information obesity
            </a>
            .
          </p>

          <p className="font-serif text-2xl font-light leading-[1.8] text-[#1A1A1A]/80">
            You may be successful by every measure, thriving even. But{" "}
            <strong className="font-normal">
              you're not present for any of it.
            </strong>
          </p>
        </div>
      </div>
    </section>
  );
}
