import { useMemo } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force-3d";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NebulaCluster {
  id: string;
  label: string;
  color: string;
  recordCount: number;
}

export interface NebulaLink {
  source: string;
  target: string;
  weight: number;
}

export interface PositionedCluster extends NebulaCluster {
  x: number;
  y: number;
  z: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useForceLayout(
  clusters: NebulaCluster[],
  links: NebulaLink[],
): PositionedCluster[] {
  return useMemo(() => {
    if (!clusters.length) return [];

    const SCALE = 1.2;

    // Create simulation nodes with initial random positions
    const nodes = clusters.map((c) => ({
      ...c,
      x: (Math.random() - 0.5) * 6,
      y: (Math.random() - 0.5) * 6,
      z: (Math.random() - 0.5) * 4,
      size: Math.sqrt(c.recordCount) * 0.35,
    }));

    // Run simulation synchronously (tick N times, then read positions)
    const sim = forceSimulation(nodes, 3)
      .force("charge", forceManyBody().strength(-2.5))
      .force("center", forceCenter(0, 0, 0))
      .force(
        "collide",
        forceCollide((d: any) => d.size * SCALE + 0.4),
      )
      .stop();

    // Tick 120 times to stabilise
    for (let i = 0; i < 120; i++) sim.tick();

    return nodes.map((n) => ({
      id: n.id,
      label: n.label,
      color: n.color,
      recordCount: n.recordCount,
      x: n.x ?? 0,
      y: n.y ?? 0,
      z: n.z ?? 0,
      size: n.size,
    }));
  }, [clusters, links]);
}
