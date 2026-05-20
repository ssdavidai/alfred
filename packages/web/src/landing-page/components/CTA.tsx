import { useEffect, useRef } from "react";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import { Button } from "../../client/components/ui/button";

export default function CTA() {
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
      { threshold: 0.2 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="bg-cream px-6 py-32 text-center lg:py-40"
    >
      <div className="mx-auto max-w-[520px]">
        <h2 className="reveal font-serif text-3xl font-light leading-[1.4] text-[#1A1A1A] md:text-4xl">
          Ready for a life attended to?
        </h2>

        <div className="reveal mt-12">
          <Button size="lg" asChild>
            <WaspRouterLink to={routes.SignupRoute.to}>
              DEPLOY YOUR BUTLER
            </WaspRouterLink>
          </Button>
        </div>
      </div>
    </section>
  );
}
