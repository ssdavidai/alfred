import { useRef, useMemo, useState, useCallback } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useForceLayout } from "./useForceLayout";
import LinkFilaments from "./LinkFilaments";
import type { NebulaCluster, NebulaLink, PositionedCluster } from "./useForceLayout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NebulaData {
  clusters: NebulaCluster[];
  links: NebulaLink[];
}

interface NebulaSceneProps {
  data: NebulaData;
  onRecordClick?: (clusterId: string, position?: { x: number; y: number; z: number }) => void;
}

// ---------------------------------------------------------------------------
// Helpers — connected cluster IDs for a given cluster
// ---------------------------------------------------------------------------

function getConnectedIds(clusterId: string, links: NebulaLink[]): Set<string> {
  const connected = new Set<string>();
  for (const link of links) {
    if (link.source === clusterId) connected.add(link.target);
    if (link.target === clusterId) connected.add(link.source);
  }
  return connected;
}

// ---------------------------------------------------------------------------
// Cloud texture — generated once and reused
// ---------------------------------------------------------------------------

let _cloudTexture: THREE.Texture | null = null;

function getCloudTexture(): THREE.Texture {
  if (_cloudTexture) return _cloudTexture;

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, "rgba(255,255,255,0.6)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.3)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.05)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  _cloudTexture = new THREE.CanvasTexture(canvas);
  return _cloudTexture;
}

// ---------------------------------------------------------------------------
// Cloud Group — layered billboard sprites for a single cluster
// ---------------------------------------------------------------------------

interface CloudGroupProps {
  cluster: PositionedCluster;
  onRecordClick?: (clusterId: string, position?: { x: number; y: number; z: number }) => void;
  /** Dim multiplier applied to opacity. 1.0 = normal, < 1 = dimmed, > 1 = brightened */
  dimFactor: number;
}

interface SpriteData {
  offset: THREE.Vector3;
  scale: number;
  opacity: number;
}

function CloudGroup({ cluster, onRecordClick, dimFactor }: CloudGroupProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const texture = useMemo(() => getCloudTexture(), []);

  const { x, y, z, color, size, recordCount, label, id } = cluster;

  const sprites: SpriteData[] = useMemo(() => {
    const count = Math.min(12, Math.max(6, Math.floor(recordCount / 5)));
    return Array.from({ length: count }, () => ({
      offset: new THREE.Vector3(
        (Math.random() - 0.5) * size * 0.6,
        (Math.random() - 0.5) * size * 0.6,
        (Math.random() - 0.5) * size * 0.4,
      ),
      scale: size * (0.5 + Math.random() * 0.8),
      opacity: 0.08 + Math.random() * 0.12,
    }));
  }, [size, recordCount]);

  // Breathing + slow rotation
  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    groupRef.current.scale.setScalar(1 + Math.sin(t * 0.3) * 0.03);
    groupRef.current.rotation.y += 0.0003;
  });

  const handleClick = useCallback(() => {
    onRecordClick?.(id, { x, y, z });
  }, [onRecordClick, id, x, y, z]);

  // Effective opacity factor: hover brightens, dimFactor dims/brightens
  const effectiveOpacityFactor = hovered ? dimFactor * 2.5 : dimFactor;

  return (
    <group
      ref={groupRef}
      position={[x, y, z]}
      onClick={handleClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      {sprites.map((s, i) => (
        <sprite
          key={i}
          position={s.offset}
          scale={[s.scale, s.scale, 1]}
        >
          <spriteMaterial
            map={texture}
            color={color}
            transparent
            opacity={Math.min(1, s.opacity * effectiveOpacityFactor)}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
      ))}

      {/* Enhanced tooltip — visible on hover */}
      {hovered && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div
            style={{
              background: "rgba(0,0,0,0.80)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(201,168,76,0.3)",
              borderRadius: 10,
              padding: "8px 14px",
              whiteSpace: "nowrap",
              minWidth: 120,
            }}
          >
            {/* Cluster label */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: color,
                  boxShadow: `0 0 8px ${color}60`,
                }}
              />
              <span
                style={{
                  color: "#F0EDE8",
                  fontFamily: "monospace",
                  fontSize: 11,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  fontWeight: 500,
                }}
              >
                {label}
              </span>
            </div>
            {/* Record count */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span
                style={{
                  color: "rgba(201,168,76,0.7)",
                  fontFamily: "monospace",
                  fontSize: 10,
                }}
              >
                {recordCount} record{recordCount !== 1 ? "s" : ""}
              </span>
              <span
                style={{
                  color: "rgba(240,237,232,0.3)",
                  fontFamily: "monospace",
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                click to explore
              </span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ambient star particles
// ---------------------------------------------------------------------------

function StarField() {
  const count = 400;
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 30;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 30;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    return arr;
  }, []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  return (
    <points geometry={geometry}>
      <pointsMaterial
        size={0.02}
        color="#C9A84C"
        transparent
        opacity={0.4}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

// ---------------------------------------------------------------------------
// Main Scene
// ---------------------------------------------------------------------------

export default function NebulaScene({ data, onRecordClick }: NebulaSceneProps) {
  const positioned = useForceLayout(data.clusters, data.links);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Compute connected IDs for the hovered cluster
  const connectedIds = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    return getConnectedIds(hoveredId, data.links);
  }, [hoveredId, data.links]);

  // Compute dim factor for each cluster
  const getDimFactor = useCallback(
    (clusterId: string): number => {
      if (!hoveredId) return 1.0;
      if (clusterId === hoveredId) return 1.5;
      if (connectedIds.has(clusterId)) return 1.0;
      return 0.3;
    },
    [hoveredId, connectedIds],
  );

  // Wrap onRecordClick and also track hover for dimming
  const handlePointerOver = useCallback((clusterId: string) => {
    setHoveredId(clusterId);
  }, []);

  const handlePointerOut = useCallback(() => {
    setHoveredId(null);
  }, []);

  return (
    <>
      <StarField />
      <LinkFilaments clusters={positioned} links={data.links} />
      {positioned.map((cluster) => (
        <CloudGroupWrapper
          key={cluster.id}
          cluster={cluster}
          onRecordClick={onRecordClick}
          dimFactor={getDimFactor(cluster.id)}
          onHoverIn={handlePointerOver}
          onHoverOut={handlePointerOut}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Wrapper to intercept hover events at the scene level
// ---------------------------------------------------------------------------

interface CloudGroupWrapperProps {
  cluster: PositionedCluster;
  onRecordClick?: (clusterId: string, position?: { x: number; y: number; z: number }) => void;
  dimFactor: number;
  onHoverIn: (clusterId: string) => void;
  onHoverOut: () => void;
}

function CloudGroupWrapper({
  cluster,
  onRecordClick,
  dimFactor,
  onHoverIn,
  onHoverOut,
}: CloudGroupWrapperProps) {
  const handlePointerOver = useCallback(
    (e: { stopPropagation?: () => void }) => {
      // Stop propagation so only the nearest cloud triggers
      e.stopPropagation?.();
      onHoverIn(cluster.id);
    },
    [cluster.id, onHoverIn],
  );

  const handlePointerOut = useCallback(() => {
    onHoverOut();
  }, [onHoverOut]);

  return (
    <group onPointerOver={handlePointerOver} onPointerOut={handlePointerOut}>
      <CloudGroup
        cluster={cluster}
        onRecordClick={onRecordClick}
        dimFactor={dimFactor}
      />
    </group>
  );
}
