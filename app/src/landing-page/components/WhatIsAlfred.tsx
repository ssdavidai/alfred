import { useEffect, useRef } from "react";

export default function WhatIsAlfred() {
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
      { threshold: 0.15 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="bg-[#0A0A0A] px-6 py-32 lg:py-40"
    >
      <div className="mx-auto max-w-[900px]">
        <p className="reveal font-mono text-sm font-light uppercase tracking-[0.45em] text-gold">
          WHAT IS ALFRED
        </p>

        <h2 className="reveal mt-12 font-serif text-4xl font-light leading-[1.3] text-cream md:text-5xl">
          Alfred connects the dots for you — and steps in as your butler.
        </h2>

        <p className="reveal mt-10 font-sans text-2xl font-light leading-[1.8] text-[#8A8680]">
          Instead of everything demanding your attention, Alfred filters what
          truly matters. Not software. Not another app. A fully managed service
          — an agentic butler that handles your calendar, email, finances, health data,
          and family logistics while you sleep.
        </p>

        <div className="reveal mt-14 border-l-2 border-gold pl-8">
          <p className="font-serif text-2xl font-light italic leading-relaxed text-cream">
            You don't configure Alfred. Alfred serves you.
          </p>
        </div>
      </div>
    </section>
  );
}
