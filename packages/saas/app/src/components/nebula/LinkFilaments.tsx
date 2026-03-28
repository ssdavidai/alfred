import { useRef, useEffect, useMemo } from "react";
import * as THREE from "three";
import type { PositionedCluster, NebulaLink } from "./useForceLayout";

// ---------------------------------------------------------------------------
// Link Filaments — thin glowing gold lines between cloud clusters
// ---------------------------------------------------------------------------

interface LinkFilamentsProps {
  clusters: PositionedCluster[];
  links: NebulaLink[];
}

export default function LinkFilaments({ clusters, links }: LinkFilamentsProps) {
  const groupRef = useRef<THREE.Group>(null);

  const clusterMap = useMemo(
    () => new Map(clusters.map((c: PositionedCluster) => [c.id, c])),
    [clusters],
  );

  // Only render cross-cluster links
  const validLinks = useMemo(
    () =>
      links.filter(
        (l: NebulaLink) =>
          l.source !== l.target &&
          clusterMap.has(l.source) &&
          clusterMap.has(l.target),
      ),
    [links, clusterMap],
  );

  useEffect(() => {
    if (!groupRef.current) return;
    // Clear existing children
    while (groupRef.current.children.length > 0) {
      const child = groupRef.current.children[0];
      groupRef.current.remove(child);
      if ((child as any).geometry) (child as any).geometry.dispose();
      if ((child as any).material) (child as any).material.dispose();
    }

    const material = new THREE.LineBasicMaterial({
      color: 0xC9A84C,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    for (const link of validLinks) {
      const a = clusterMap.get(link.source)!;
      const b = clusterMap.get(link.target)!;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]);
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(geometry, material);
      groupRef.current.add(line);
    }
  }, [validLinks, clusterMap]);

  return <group ref={groupRef} />;
}
