import { useEffect, useRef } from "react";
import ParticleCanvas from "./ParticleCanvas";

export default function Hero() {
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
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0A0A0A]"
    >
      <ParticleCanvas particleCount={80} />

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <h1 className="reveal font-serif text-[clamp(3rem,7vw,6.5rem)] font-light leading-[1.1] text-cream">
          Your life, attended to.
        </h1>

        <div className="reveal mt-8 h-px w-[60px] bg-gold" />

        <p className="reveal mt-8 max-w-[640px] font-serif text-2xl font-light italic leading-relaxed text-[#8A8680]">
          Get started with the world's first fully managed agentic butler.
        </p>

        <a
          href="#early-access"
          className="reveal mt-12 inline-block border border-gold bg-transparent px-10 py-4 font-mono text-sm font-light uppercase tracking-[0.35em] text-gold transition-all duration-300 hover:bg-gold hover:text-[#0A0A0A]"
        >
          Hire Alfred
        </a>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
        <div className="h-8 w-px animate-scroll-pulse bg-gold" />
      </div>
    </section>
  );
}
