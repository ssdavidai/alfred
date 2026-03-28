import { Suspense, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Loader2 } from "lucide-react";
import NebulaScene from "./NebulaScene";
import type { NebulaData } from "./NebulaScene";

// ---------------------------------------------------------------------------
// Camera API — exposed to parent via ref
// ---------------------------------------------------------------------------

export interface CameraApi {
  zoomTo: (x: number, y: number, z: number) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VaultNebulaProps {
  nebulaData: NebulaData | null;
  onRecordClick?: (clusterId: string, position?: { x: number; y: number; z: number }) => void;
  cameraRef?: React.RefObject<CameraApi | null>;
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function NebulaLoading() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <Loader2 className="h-6 w-6 animate-spin text-[#C9A84C]" />
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-[#F0EDE8]/40">
        Mapping vault topology...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera controller — handles smooth zoom and reset inside the canvas
// ---------------------------------------------------------------------------

const DEFAULT_POS = new THREE.Vector3(0, 0, 8);

interface CameraControllerProps {
  cameraRef?: React.RefObject<CameraApi | null>;
}

function CameraController({ cameraRef }: CameraControllerProps) {
  const { camera } = useThree();
  const targetRef = useRef<THREE.Vector3 | null>(null);
  const progressRef = useRef(0);
  const startPosRef = useRef(new THREE.Vector3());
  const isAnimatingRef = useRef(false);

  const zoomTo = useCallback(
    (x: number, y: number, z: number) => {
      startPosRef.current.copy(camera.position);
      // Offset the target so the camera looks at the cluster from a comfortable distance
      targetRef.current = new THREE.Vector3(x, y, z + 3);
      progressRef.current = 0;
      isAnimatingRef.current = true;
    },
    [camera],
  );

  const reset = useCallback(() => {
    startPosRef.current.copy(camera.position);
    targetRef.current = DEFAULT_POS.clone();
    progressRef.current = 0;
    isAnimatingRef.current = true;
  }, [camera]);

  // Expose camera API to parent via ref
  useEffect(() => {
    if (cameraRef) {
      (cameraRef as React.MutableRefObject<CameraApi | null>).current = { zoomTo, reset };
    }
    return () => {
      if (cameraRef) {
        (cameraRef as React.MutableRefObject<CameraApi | null>).current = null;
      }
    };
  }, [cameraRef, zoomTo, reset]);

  useFrame((_, delta) => {
    if (!isAnimatingRef.current || !targetRef.current) return;
    progressRef.current = Math.min(1, progressRef.current + delta * 1.0);
    // Smooth ease-out
    const t = 1 - Math.pow(1 - progressRef.current, 3);
    camera.position.lerpVectors(startPosRef.current, targetRef.current, t);
    if (progressRef.current >= 1) {
      isAnimatingRef.current = false;
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// VaultNebula — full-viewport R3F canvas
// ---------------------------------------------------------------------------

export default function VaultNebula({
  nebulaData,
  onRecordClick,
  cameraRef,
}: VaultNebulaProps) {
  if (!nebulaData) {
    return (
      <div className="fixed inset-0 z-0 bg-black">
        <NebulaLoading />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-0 bg-black">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 60 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        style={{ width: "100%", height: "100%" }}
      >
        <color attach="background" args={["#000000"]} />
        <ambientLight intensity={0.1} />

        <CameraController cameraRef={cameraRef} />

        <Suspense fallback={null}>
          <NebulaScene data={nebulaData} onRecordClick={onRecordClick} />
        </Suspense>

        <OrbitControls
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          autoRotate={true}
          autoRotateSpeed={0.3}
          maxDistance={20}
          minDistance={3}
        />

        <EffectComposer>
          <Bloom
            luminanceThreshold={0.2}
            luminanceSmoothing={0.9}
            intensity={1.5}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
