import { ReactNode } from "react";
import ParticleCanvas from "../landing-page/components/ParticleCanvas";

export function AuthPageLayout({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0A0A0A] px-4">
      <ParticleCanvas particleCount={30} opacity={0.4} />
      <div className="relative z-10 w-full max-w-md rounded-sm border border-gold-dim bg-[#0A0A0A]/80 px-8 py-10 backdrop-blur-lg">
        <div className="mb-8 flex flex-col items-center gap-4">
          <img
            src="/images/alfred-logo.png"
            alt="ALFRED BLACK"
            className="h-12 w-auto"
          />
          <div className="h-px w-[60px] bg-gold" />
          {title && (
            <h1 className="font-serif text-2xl font-light text-cream">
              {title}
            </h1>
          )}
          {subtitle && (
            <p className="font-serif text-sm font-light italic text-[#8A8680]">
              {subtitle}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
