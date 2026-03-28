import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Loader2 } from "lucide-react";
import NebulaScene from "./NebulaScene";
import type { NebulaData } from "./NebulaScene";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VaultNebulaProps {
  nebulaData: NebulaData | null;
  onRecordClick?: (clusterId: string) => void;
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
// VaultNebula — full-viewport R3F canvas
// ---------------------------------------------------------------------------

export default function VaultNebula({ nebulaData, onRecordClick }: VaultNebulaProps) {
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
