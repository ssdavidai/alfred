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
  onRecordClick?: (clusterId: string) => void;
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
  onRecordClick?: (clusterId: string) => void;
}

interface SpriteData {
  offset: THREE.Vector3;
  scale: number;
  opacity: number;
}

function CloudGroup({ cluster, onRecordClick }: CloudGroupProps) {
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
    onRecordClick?.(id);
  }, [onRecordClick, id]);

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
            opacity={hovered ? s.opacity * 2.5 : s.opacity}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
      ))}

      {/* Label — visible on hover */}
      {hovered && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div
            style={{
              background: "rgba(0,0,0,0.75)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(201,168,76,0.3)",
              borderRadius: 8,
              padding: "6px 12px",
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                color: "#F0EDE8",
                fontFamily: "monospace",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {label}
            </span>
            <span
              style={{
                color: "rgba(201,168,76,0.7)",
                fontFamily: "monospace",
                fontSize: 10,
                marginLeft: 8,
              }}
            >
              {recordCount}
            </span>
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

  return (
    <>
      <StarField />
      <LinkFilaments clusters={positioned} links={data.links} />
      {positioned.map((cluster) => (
        <CloudGroup
          key={cluster.id}
          cluster={cluster}
          onRecordClick={onRecordClick}
        />
      ))}
    </>
  );
}
