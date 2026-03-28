/**
 * VaultNebula — Pure CSS nebula cloud visualization.
 *
 * No WebGL, no Three.js, no Canvas. Just layered radial gradients with
 * CSS animations and an SVG gooey blur filter that makes them merge
 * into organic cloud shapes. Runs at 60fps on any device including phones.
 *
 * Each gradient blob represents a cluster region in the vault. Colors
 * map to record types: gold (notes), teal (decisions), red (triage),
 * purple (haze), bright gold (core).
 */

// ---------------------------------------------------------------------------
// Cloud definitions — position, color, size, animation timing
// ---------------------------------------------------------------------------

const CLOUDS = [
  // Large gold nebula (center-left) — notes, conversations
  { x: 35, y: 40, color: "#C9A84C", size: 55, duration: 25, delay: 0 },
  { x: 30, y: 50, color: "#B8960B", size: 45, duration: 30, delay: 1 },

  // Teal region (right) — decisions, assumptions
  { x: 70, y: 35, color: "#1E4D5E", size: 40, duration: 28, delay: 2 },
  { x: 75, y: 45, color: "#2A6B7C", size: 35, duration: 22, delay: 0.5 },

  // Warm red wisp (upper) — triage
  { x: 25, y: 20, color: "#FF6B6B", size: 30, duration: 32, delay: 1.5 },

  // Deep purple haze (lower-right)
  { x: 60, y: 70, color: "#553888", size: 45, duration: 35, delay: 3 },
  { x: 55, y: 75, color: "#4A2D78", size: 35, duration: 27, delay: 1 },

  // Bright gold core (center)
  { x: 50, y: 45, color: "#D4AF37", size: 50, duration: 20, delay: 0 },
  { x: 45, y: 50, color: "#C9A84C", size: 40, duration: 24, delay: 2 },

  // Subtle fill clouds for depth
  { x: 20, y: 65, color: "#8B7532", size: 35, duration: 38, delay: 2.5 },
  { x: 80, y: 60, color: "#2A4A5E", size: 30, duration: 33, delay: 1 },
  { x: 50, y: 20, color: "#C9A84C", size: 25, duration: 29, delay: 3 },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VaultNebulaProps {
  nebulaData?: unknown;
}

export default function VaultNebula(_props: VaultNebulaProps) {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-black">
      {/* SVG filter for organic cloud merging */}
      <svg className="absolute h-0 w-0">
        <defs>
          <filter id="nebula-gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="30" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -8"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>

      {/* Cloud layer with gooey filter */}
      <div
        className="absolute inset-0"
        style={{ filter: "url(#nebula-gooey)" }}
      >
        {CLOUDS.map((cloud, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${cloud.x}%`,
              top: `${cloud.y}%`,
              width: `${cloud.size}vmax`,
              height: `${cloud.size}vmax`,
              transform: "translate(-50%, -50%)",
              background: `radial-gradient(circle, ${cloud.color}40 0%, ${cloud.color}15 40%, transparent 70%)`,
              animation: `nebula-drift-${i % 4} ${cloud.duration}s ease-in-out infinite`,
              animationDelay: `${cloud.delay}s`,
            }}
          />
        ))}
      </div>

      {/* Breathing overlay — slow global pulse */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 45% 45%, rgba(201,168,76,0.06) 0%, transparent 60%)",
          animation: "nebula-breathe 8s ease-in-out infinite",
        }}
      />

      {/* Keyframes */}
      <style>{`
        @keyframes nebula-drift-0 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          25% { transform: translate(-50%, -50%) translate(2vw, -1.5vh); }
          50% { transform: translate(-50%, -50%) translate(-1vw, 2vh); }
          75% { transform: translate(-50%, -50%) translate(1.5vw, 1vh); }
        }
        @keyframes nebula-drift-1 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          33% { transform: translate(-50%, -50%) translate(-2vw, 1vh); }
          66% { transform: translate(-50%, -50%) translate(1.5vw, -2vh); }
        }
        @keyframes nebula-drift-2 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          25% { transform: translate(-50%, -50%) translate(1vw, 2vh); }
          50% { transform: translate(-50%, -50%) translate(-2vw, -1vh); }
          75% { transform: translate(-50%, -50%) translate(2vw, -1.5vh); }
        }
        @keyframes nebula-drift-3 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          50% { transform: translate(-50%, -50%) translate(-1.5vw, 1.5vh); }
        }
        @keyframes nebula-breathe {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
