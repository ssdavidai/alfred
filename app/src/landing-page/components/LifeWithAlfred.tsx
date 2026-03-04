import { useEffect, useRef } from "react";

const vignettes = [
  {
    time: "07:00",
    label: "MORNING",
    description:
      "You wake up. No scrambling through apps, no rebuilding context. Alfred has already sent your briefing \u2014 your schedule, your health data, what needs attention and what doesn\u2019t. Ninety seconds and you know your entire day.",
  },
  {
    time: "12:30",
    label: "MIDDAY",
    description:
      "You\u2019re deep in work. Your phone rings \u2014 not a notification, a call. Alfred tells you traffic is heavy, leave now for your two o\u2019clock. You grab your keys without checking a screen.",
  },
  {
    time: "19:00",
    label: "EVENING",
    description:
      "You\u2019re cooking. You realize you\u2019re out of rice. You say it out loud. Alfred adds it to the list. Sunday night, the groceries arrive.",
  },
  {
    time: "22:00",
    label: "NIGHT",
    description:
      "Last week you promised to fix your sister-in-law\u2019s drawer. You forgot the moment you said it. Alfred didn\u2019t. Tomorrow\u2019s briefing, right where it belongs.",
  },
];

export default function LifeWithAlfred() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".reveal").forEach((el, i) => {
              setTimeout(() => el.classList.add("visible"), i * 200);
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
          A DAY ATTENDED
        </p>

        <h2 className="reveal mt-12 font-serif text-4xl font-light leading-[1.3] text-[#1A1A1A] md:text-5xl">
          Life with Alfred
        </h2>

        <div className="mt-16 space-y-16">
          {vignettes.map((v) => (
            <div key={v.time} className="reveal">
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-lg font-light text-gold">
                  {v.time}
                </span>
                <span className="font-mono text-sm font-light uppercase tracking-[0.35em] text-[#8A8680]">
                  {v.label}
                </span>
              </div>
              <p className="mt-4 font-serif text-2xl font-light leading-[1.8] text-[#1A1A1A]/80">
                {v.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
