import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useEffect } from "react";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// GLSL Shaders — Volumetric raymarching nebula
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec2 uResolution;

  varying vec2 vUv;

  // ---- Noise functions ----

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  // Fractal Brownian Motion — 6 octaves
  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    for (int i = 0; i < 6; i++) {
      value += amplitude * noise(p * frequency);
      frequency *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  // ---- Cloud sampling for a single region ----
  // Avoids struct arrays (WebGL1 compatibility)

  float sampleCloud(vec3 pos, vec3 center, float radius, float density) {
    vec3 cloudPos = pos - center;
    float dist = length(cloudPos) / radius;
    float falloff = exp(-dist * dist * 2.0);
    float noiseDensity = fbm(cloudPos * 2.0 + uTime * 0.02);
    float d = falloff * noiseDensity * density;
    return smoothstep(0.15, 0.6, d);
  }

  // ---- Raymarching ----

  vec4 raymarchNebula(vec3 ro, vec3 rd) {
    // Cloud centers
    vec3 c0 = vec3(-0.3, 0.0, 0.0);   // Gold (center-left)
    vec3 c1 = vec3(0.5, 0.2, 0.3);    // Teal (right)
    vec3 c2 = vec3(-0.4, 0.5, -0.2);  // Warm red (upper left)
    vec3 c3 = vec3(0.1, -0.4, 0.1);   // Purple (lower)
    vec3 c4 = vec3(0.0, 0.0, 0.0);    // Bright gold core (center)

    // Cloud colors
    vec3 col0 = vec3(0.788, 0.659, 0.298);  // #C9A84C gold
    vec3 col1 = vec3(0.118, 0.302, 0.369);  // #1E4D5E teal
    vec3 col2 = vec3(1.0, 0.42, 0.42);      // #FF6B6B warm red
    vec3 col3 = vec3(0.33, 0.22, 0.55);     // #553888 purple
    vec3 col4 = vec3(0.831, 0.686, 0.216);  // #D4AF37 bright gold

    // Cloud radii and densities
    float r0 = 1.2;  float d0 = 0.8;
    float r1 = 0.9;  float d1 = 0.6;
    float r2 = 0.7;  float d2 = 0.4;
    float r3 = 1.0;  float d3 = 0.5;
    float r4 = 0.6;  float d4 = 1.0;

    vec4 accumulated = vec4(0.0);
    float maxDist = 4.0;
    float stepSize = maxDist / 64.0;
    float t = 0.0;

    for (int i = 0; i < 64; i++) {
      if (accumulated.a > 0.95) break;

      vec3 pos = ro + rd * t;

      // Breathing animation
      vec3 animPos = pos + vec3(
        sin(uTime * 0.1) * 0.1,
        cos(uTime * 0.08) * 0.05,
        sin(uTime * 0.12) * 0.08
      );

      // Sample all 5 cloud regions
      float s0 = sampleCloud(animPos, c0, r0, d0);
      float s1 = sampleCloud(animPos, c1, r1, d1);
      float s2 = sampleCloud(animPos, c2, r2, d2);
      float s3 = sampleCloud(animPos, c3, r3, d3);
      float s4 = sampleCloud(animPos, c4, r4, d4);

      float totalDensity = s0 + s1 + s2 + s3 + s4;

      if (totalDensity > 0.01) {
        vec3 totalColor = col0 * s0 + col1 * s1 + col2 * s2 + col3 * s3 + col4 * s4;
        vec3 color = totalColor / max(totalDensity, 0.01);

        // Emissive glow for bright regions
        color += color * totalDensity * 0.5;

        // Front-to-back compositing
        float alpha = min(totalDensity * stepSize * 3.0, 1.0);
        accumulated.rgb += (1.0 - accumulated.a) * color * alpha;
        accumulated.a += (1.0 - accumulated.a) * alpha;
      }

      t += stepSize;
    }

    return accumulated;
  }

  void main() {
    // Screen coords (-1 to 1, aspect corrected)
    vec2 uv = (gl_FragCoord.xy / uResolution.xy) * 2.0 - 1.0;
    uv.x *= uResolution.x / uResolution.y;

    // Fixed camera looking into the nebula
    vec3 ro = vec3(0.0, 0.0, -2.0);
    vec3 rd = normalize(vec3(uv, 1.5));

    vec4 nebula = raymarchNebula(ro, rd);

    vec3 finalColor = nebula.rgb;

    // Subtle star field
    float stars = pow(hash(vec3(floor(gl_FragCoord.xy * 0.5), 1.0)), 20.0);
    finalColor += vec3(stars * 0.3);

    // Reinhard tone mapping
    finalColor = finalColor / (1.0 + finalColor);

    // Vignette
    float vignette = 1.0 - dot(vUv - 0.5, vUv - 0.5) * 0.5;
    finalColor *= vignette;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// NebulaQuad — fullscreen quad with the raymarching shader
// ---------------------------------------------------------------------------

function NebulaQuad() {
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uResolution: {
        value: new THREE.Vector2(window.innerWidth, window.innerHeight),
      },
    }),
    [],
  );

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime;
  });

  useEffect(() => {
    const handleResize = () => {
      uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [uniforms]);

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// VaultNebula — full-viewport R3F canvas with volumetric shader
// ---------------------------------------------------------------------------

export default function VaultNebula() {
  return (
    <div className="fixed inset-0 z-0" style={{ background: "#000" }}>
      <Canvas
        orthographic
        camera={{ zoom: 1, near: 0.1, far: 10, position: [0, 0, 1] }}
        gl={{ antialias: false, alpha: false }}
        style={{ width: "100%", height: "100%" }}
      >
        <NebulaQuad />
      </Canvas>
    </div>
  );
}
