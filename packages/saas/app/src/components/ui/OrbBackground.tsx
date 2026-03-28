import { useEffect, useRef } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";

// ---------------------------------------------------------------------------
// Gradient definitions for animated background
// ---------------------------------------------------------------------------

const GRADIENTS = [
  { color: "#C9A84C", size: 300, duration: 22, delay: 0 },
  { color: "#D4AF37", size: 250, duration: 28, delay: 2 },
  { color: "#8B7532", size: 350, duration: 34, delay: 1 },
  { color: "#FFD700", size: 200, duration: 20, delay: 3 },
  { color: "#B8860B", size: 280, duration: 40, delay: 1.5 },
];

interface OrbBackgroundProps {
  /** Controls overall opacity of the gradients (0.0 to 1.0) */
  intensity?: number;
}

export default function OrbBackground({ intensity = 1.0 }: OrbBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(
    typeof window !== "undefined" ? window.innerWidth / 2 : 500,
  );
  const mouseY = useMotionValue(
    typeof window !== "undefined" ? window.innerHeight / 2 : 400,
  );
  const smoothX = useSpring(mouseX, { stiffness: 30, damping: 20 });
  const smoothY = useSpring(mouseY, { stiffness: 30, damping: 20 });

  useEffect(() => {
    const handleMouse = (e: MouseEvent) => {
      mouseX.set(e.clientX);
      mouseY.set(e.clientY);
    };
    window.addEventListener("mousemove", handleMouse);
    return () => window.removeEventListener("mousemove", handleMouse);
  }, [mouseX, mouseY]);

  // Track mouse influence per gradient
  const gradientRefs = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    let raf: number;
    const update = () => {
      const mx = smoothX.get();
      const my = smoothY.get();
      gradientRefs.current.forEach((el: HTMLDivElement | null) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (mx - cx) * 0.04;
        const dy = (my - cy) * 0.04;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [smoothX, smoothY]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
        opacity: intensity,
      }}
    >
      {/* SVG gooey filter for organic gradient merging */}
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="gooey-orb">
            <feGaussianBlur in="SourceGraphic" stdDeviation="40" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <style>{`
        @keyframes orbGradient0 {
          0%, 100% { top: 20%; left: 30%; }
          25% { top: 35%; left: 55%; }
          50% { top: 50%; left: 40%; }
          75% { top: 30%; left: 20%; }
        }
        @keyframes orbGradient1 {
          0%, 100% { top: 60%; left: 60%; }
          25% { top: 40%; left: 35%; }
          50% { top: 25%; left: 55%; }
          75% { top: 55%; left: 45%; }
        }
        @keyframes orbGradient2 {
          0%, 100% { top: 40%; left: 50%; }
          25% { top: 55%; left: 25%; }
          50% { top: 35%; left: 60%; }
          75% { top: 50%; left: 40%; }
        }
        @keyframes orbGradient3 {
          0%, 100% { top: 30%; left: 40%; }
          25% { top: 50%; left: 60%; }
          50% { top: 60%; left: 30%; }
          75% { top: 35%; left: 50%; }
        }
        @keyframes orbGradient4 {
          0%, 100% { top: 55%; left: 35%; }
          25% { top: 30%; left: 50%; }
          50% { top: 45%; left: 25%; }
          75% { top: 60%; left: 55%; }
        }
      `}</style>

      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          filter: "url(#gooey-orb)",
        }}
      >
        {GRADIENTS.map((g, i) => (
          <motion.div
            key={i}
            ref={(el: HTMLDivElement | null) => {
              if (el) gradientRefs.current[i] = el;
            }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 2, delay: g.delay, ease: "easeOut" }}
            style={{
              position: "absolute",
              width: g.size,
              height: g.size,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${g.color}55 0%, ${g.color}20 40%, transparent 70%)`,
              animation: `orbGradient${i} ${g.duration}s ease-in-out infinite`,
              marginLeft: -g.size / 2,
              marginTop: -g.size / 2,
              willChange: "top, left, transform",
            }}
          />
        ))}
      </div>
    </div>
  );
}
