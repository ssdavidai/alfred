export default function ComingSoonOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-black/30">
        <span className="rounded-sm bg-gold px-3 py-1 font-mono text-xs font-medium uppercase tracking-[0.3em] text-[#0A0A0A]">
          Coming Soon
        </span>
      </div>
    </div>
  );
}
