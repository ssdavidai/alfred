/**
 * VaultNebula — Data-driven CSS nebula cloud visualization.
 *
 * Pure CSS — no WebGL, no Canvas. Layered radial gradients with a refined
 * SVG blur filter that merges them into organic cloud shapes. Each cloud
 * region is generated from real vault cluster data (record types + counts).
 *
 * HD quality: lower blur stdDeviation (12), more gradient layers with
 * multiple opacity stops, fine grain detail clouds for texture.
 */

import { useMemo } from "react";

// ---------------------------------------------------------------------------
// Color mapping — vault record type → nebula cloud color
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  note: "#C9A84C",
  conversation: "#C9A84C",
  task: "#E8DCC8",
  decision: "#1E4D5E",
  assumption: "#2A6B7C",
  constraint: "#1E4D5E",
  contradiction: "#FF6B6B",
  synthesis: "#7B68AE",
  triage: "#FF6B6B",
  project: "#D4AF37",
  matter: "#D4AF37",
  person: "#C9A84C",
  org: "#B8960B",
  event: "#8B7532",
  observation: "#553888",
  instinct: "#7B68AE",
  reflection: "#4A2D78",
  location: "#2A6B7C",
  skill: "#D4AF37",
};

const DEFAULT_COLOR = "#8B7532";

// ---------------------------------------------------------------------------
// Cloud generation from vault data
// ---------------------------------------------------------------------------

interface CloudDef {
  x: number;
  y: number;
  color: string;
  size: number;
  opacity: number;
  duration: number;
  delay: number;
  drift: number;
}

/** Deterministic pseudo-random from seed (for stable cloud positions) */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateClouds(
  vaultTypes: Record<string, number> | null,
): CloudDef[] {
  if (!vaultTypes || Object.keys(vaultTypes).length === 0) {
    // Fallback: ambient gold nebula when no data
    return [
      { x: 40, y: 45, color: "#C9A84C", size: 50, opacity: 0.25, duration: 25, delay: 0, drift: 0 },
      { x: 60, y: 40, color: "#D4AF37", size: 40, opacity: 0.2, duration: 30, delay: 1, drift: 1 },
      { x: 50, y: 55, color: "#8B7532", size: 45, opacity: 0.15, duration: 35, delay: 2, drift: 2 },
      { x: 35, y: 35, color: "#1E4D5E", size: 30, opacity: 0.12, duration: 28, delay: 1.5, drift: 3 },
      { x: 65, y: 60, color: "#553888", size: 35, opacity: 0.1, duration: 32, delay: 3, drift: 0 },
    ];
  }

  const types = Object.entries(vaultTypes)
    .filter(([_, count]: [string, number]) => count > 0)
    .sort(([, a]: [string, number], [, b]: [string, number]) => b - a);

  const totalRecords = types.reduce((sum: number, [, c]: [string, number]) => sum + c, 0);
  const clouds: CloudDef[] = [];
  const rand = seededRandom(42);

  // Position clusters in a loose spiral/scatter
  const centerX = 50;
  const centerY = 48;

  types.forEach(([type, count]: [string, number], i: number) => {
    const color = TYPE_COLORS[type] || DEFAULT_COLOR;
    const weight = count / totalRecords;

    // Position: spiral outward from center
    const angle = (i / types.length) * Math.PI * 2 + rand() * 0.5;
    const radius = 12 + i * 4 + rand() * 8;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;

    // Size proportional to record count (sqrt for visual balance)
    const baseSize = 15 + Math.sqrt(weight) * 50;

    // Main cloud blob
    clouds.push({
      x, y, color,
      size: baseSize,
      opacity: 0.12 + weight * 0.2,
      duration: 20 + rand() * 20,
      delay: rand() * 4,
      drift: i % 6,
    });

    // Secondary detail blob (offset, smaller, same color)
    clouds.push({
      x: x + (rand() - 0.5) * 10,
      y: y + (rand() - 0.5) * 8,
      color,
      size: baseSize * 0.6,
      opacity: 0.08 + weight * 0.1,
      duration: 25 + rand() * 15,
      delay: rand() * 3,
      drift: (i + 2) % 6,
    });

    // Faint halo for larger clusters
    if (weight > 0.1) {
      clouds.push({
        x: x + (rand() - 0.5) * 6,
        y: y + (rand() - 0.5) * 6,
        color,
        size: baseSize * 1.3,
        opacity: 0.04,
        duration: 30 + rand() * 10,
        delay: rand() * 2,
        drift: (i + 4) % 6,
      });
    }
  });

  return clouds;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VaultNebulaProps {
  /** vault.types from getDashboardData: Record<string, number> */
  vaultTypes?: Record<string, number> | null;
}

export default function VaultNebula({ vaultTypes }: VaultNebulaProps) {
  const clouds = useMemo(
    () => generateClouds(vaultTypes ?? null),
    [vaultTypes],
  );

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-black">
      {/* Cloud layer — each blob has its own CSS blur for smooth, high-res edges */}
      <div className="absolute inset-0">
        {clouds.map((cloud: CloudDef, i: number) => (
          <div
            key={i}
            className="absolute rounded-full will-change-transform"
            style={{
              left: `${cloud.x}%`,
              top: `${cloud.y}%`,
              width: `${cloud.size}vmin`,
              height: `${cloud.size}vmin`,
              transform: "translate(-50%, -50%)",
              background: `radial-gradient(ellipse at 48% 46%, ${cloud.color}${hex(cloud.opacity * 1.8)} 0%, ${cloud.color}${hex(cloud.opacity * 1.2)} 15%, ${cloud.color}${hex(cloud.opacity * 0.7)} 35%, ${cloud.color}${hex(cloud.opacity * 0.3)} 55%, ${cloud.color}${hex(cloud.opacity * 0.08)} 75%, transparent 100%)`,
              filter: `blur(${Math.max(8, cloud.size * 0.6)}px)`,
              mixBlendMode: "screen",
              animation: `nebula-drift-${cloud.drift} ${cloud.duration}s ease-in-out infinite`,
              animationDelay: `${cloud.delay}s`,
            }}
          />
        ))}
      </div>

      {/* Breathing overlay — slow global pulse */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 48% 46%, rgba(201,168,76,0.04) 0%, transparent 55%)",
          animation: "nebula-breathe 8s ease-in-out infinite",
        }}
      />

      {/* Keyframes — 6 drift patterns for variety */}
      <style>{`
        @keyframes nebula-drift-0 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          25% { transform: translate(-50%, -50%) translate(1.5vw, -1vh); }
          50% { transform: translate(-50%, -50%) translate(-0.5vw, 1.5vh); }
          75% { transform: translate(-50%, -50%) translate(1vw, 0.5vh); }
        }
        @keyframes nebula-drift-1 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          33% { transform: translate(-50%, -50%) translate(-1.5vw, 0.8vh); }
          66% { transform: translate(-50%, -50%) translate(1vw, -1.2vh); }
        }
        @keyframes nebula-drift-2 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          25% { transform: translate(-50%, -50%) translate(0.8vw, 1.5vh); }
          50% { transform: translate(-50%, -50%) translate(-1.2vw, -0.5vh); }
          75% { transform: translate(-50%, -50%) translate(1.5vw, -1vh); }
        }
        @keyframes nebula-drift-3 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          50% { transform: translate(-50%, -50%) translate(-1vw, 1vh); }
        }
        @keyframes nebula-drift-4 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          30% { transform: translate(-50%, -50%) translate(1vw, -0.8vh); }
          70% { transform: translate(-50%, -50%) translate(-0.8vw, 1.2vh); }
        }
        @keyframes nebula-drift-5 {
          0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
          40% { transform: translate(-50%, -50%) translate(-1.2vw, -0.5vh); }
          80% { transform: translate(-50%, -50%) translate(0.5vw, 1vh); }
        }
        @keyframes nebula-breathe {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.03); }
        }
      `}</style>
    </div>
  );
}

/** Convert opacity 0-1 to 2-char hex for CSS color alpha */
function hex(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
}
