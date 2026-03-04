import { useEffect, useRef } from "react";
import GraphCanvas from "./GraphCanvas";

export default function KnowledgeGraph() {
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
      className="bg-[#0A0A0A] px-6 py-32 lg:py-40"
    >
      <div className="mx-auto max-w-[900px] text-center">
        <p className="reveal font-serif text-2xl font-light italic leading-relaxed text-[#8A8680]">
          This is what your life looks like beneath the surface. Every person,
          project, commitment, deadline, relationship and decision — connected
          in ways your brain was never designed to track alone.
        </p>
      </div>

      <div className="reveal mx-auto mt-16 h-[70vh] w-[90vw] max-w-[1400px]">
        <GraphCanvas />
      </div>

    </section>
  );
}
