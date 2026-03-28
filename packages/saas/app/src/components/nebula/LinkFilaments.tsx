import { useMemo } from "react";
import * as THREE from "three";
import type { PositionedCluster } from "./useForceLayout";
import type { NebulaLink } from "./useForceLayout";

// ---------------------------------------------------------------------------
// Link Filaments — thin glowing gold lines between cloud clusters
// ---------------------------------------------------------------------------

interface LinkFilamentsProps {
  clusters: PositionedCluster[];
  links: NebulaLink[];
}

export default function LinkFilaments({ clusters, links }: LinkFilamentsProps) {
  const clusterMap = useMemo(
    () => new Map(clusters.map((c) => [c.id, c])),
    [clusters],
  );

  // Only render cross-cluster links
  const validLinks = useMemo(
    () =>
      links.filter(
        (l) =>
          l.source !== l.target &&
          clusterMap.has(l.source) &&
          clusterMap.has(l.target),
      ),
    [links, clusterMap],
  );

  return (
    <group>
      {validLinks.map((link, i) => {
        const a = clusterMap.get(link.source)!;
        const b = clusterMap.get(link.target)!;
        return <Filament key={`${link.source}-${link.target}-${i}`} a={a} b={b} />;
      })}
    </group>
  );
}

function Filament({
  a,
  b,
}: {
  a: PositionedCluster;
  b: PositionedCluster;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]);
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [a.x, a.y, a.z, b.x, b.y, b.z]);

  return (
    <line geometry={geometry}>
      <lineBasicMaterial
        color="#C9A84C"
        transparent
        opacity={0.08}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </line>
  );
}
