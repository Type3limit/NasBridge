import React, { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sphere, Stars, Trail, BakeShadows } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from 'postprocessing';
import * as THREE from "three";
import { generateNebulaTexture, generateGalaxyBandTexture } from "./nebulaGenerators";

// ── Cinematic Black Hole "Gargantua" style background ─────────────────────

const BH_RADIUS = 300;
const DISK_INNER = BH_RADIUS * 1.1;
const DISK_OUTER = BH_RADIUS * 14.0;
const PARTICLE_COUNT = 150000;

// Random utility
function createRng(seed) {
  let state = Math.abs(seed | 0) || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Custom shader for the Accretion Disk particles
const accretionDiskShader = {
  uniforms: {
    time: { value: 0 }
  },
  vertexShader: `
    uniform float time;
    attribute float aRadius;
    attribute float aAngle;
    attribute float aSize;
    attribute float aSpeedOffset;
    attribute vec3 aColor;
    
    varying vec3 vColor;
    varying float vAlpha;

    void main() {
      // Keplerian velocity approximation: closer = faster
      // Slower for a massive scale feel
      float baseOmega = 2000.0 / pow(aRadius, 1.5);
      float currentAngle = aAngle + time * (baseOmega + aSpeedOffset * 0.1);

      vec3 pos = position;
      pos.x = cos(currentAngle) * aRadius;
      pos.z = sin(currentAngle) * aRadius;
      
      // Slight vertical wobble based on angle + radius (lessened for massiveness)
      pos.y = sin(currentAngle * 2.0 + aRadius * 0.05) * (aRadius * 0.008);
      // Double pinch to simulate relativistic Doppler beaming
      // The side coming towards camera (positive X, assuming rotation and camera angle) will be brighter.
      float doppler = 1.0 + cos(currentAngle)*0.85; 
      
      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      
      float sizeAtten = 2500.0 / -mvPosition.z;
      gl_PointSize = aSize * sizeAtten * (0.4 + doppler*0.6);
      
      vColor = aColor * doppler; // brighten colors approaching camera
      
      // Fade out at extreme inner and outer edges
      float innerFade = smoothstep(1.0, 1.5, aRadius / ${BH_RADIUS}.0);
      float outerFade = 1.0 - smoothstep(0.7, 1.0, aRadius / ${DISK_OUTER}.0);
      vAlpha = innerFade * outerFade * clamp(doppler, 0.2, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vAlpha;
    
    void main() {
      // Soft circular particle
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if (dist > 0.5) discard;
      
      // Glow falloff
      float strength = 1.0 - (dist * 2.0);
      strength = pow(strength, 1.5);
      
      gl_FragColor = vec4(vColor, strength * vAlpha);
    }
  `
};

function AccretionDisk() {
  const pointsRef = useRef();
  
  const particles = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const radii = new Float32Array(PARTICLE_COUNT);
    const angles = new Float32Array(PARTICLE_COUNT);
    const sizes = new Float32Array(PARTICLE_COUNT);
    const speeds = new Float32Array(PARTICLE_COUNT);
    
    const rng = createRng(42);
    
    // Core high energy color (X-ray blue/white)
    const colorCore = new THREE.Color("#ffffff");
    // Mid energy color (fiery orange/yellow)
    const colorMid = new THREE.Color("#ea580c");
    // Outer lower energy edge (deep red/purple)
    const colorOuter = new THREE.Color("#2e1004");

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Exponential distribution to cluster near the inner edge
      const t = Math.pow(rng(), 1.8);
      const r = lerp(DISK_INNER, DISK_OUTER, t);
      
      const angle = rng() * Math.PI * 2;
      
      positions[i * 3 + 0] = 0;
      positions[i * 3 + 1] = (rng() - 0.5) * (r * 0.02); // Tighter thickness of disk
      positions[i * 3 + 2] = 0;
      
      radii[i] = r;
      angles[i] = angle;
      sizes[i] = rng() * 3.5 + 0.8; // Particle size variation
      speeds[i] = (rng() - 0.5) * 0.02; // Random speed perturbation, slower
      
      // Color gradient based on radius
      const color = new THREE.Color();
      if (t < 0.2) {
        color.copy(colorCore).lerp(colorMid, t / 0.2);
      } else {
        color.copy(colorMid).lerp(colorOuter, (t - 0.2) / 0.8);
      }
      
      colors[i * 3 + 0] = color.r * 1.5; // push intensity for bloom
      colors[i * 3 + 1] = color.g * 1.5;
      colors[i * 3 + 2] = color.b * 1.5;
    }
    
    return { positions, colors, radii, angles, sizes, speeds };
  }, []);

  useFrame((state) => {
    if (pointsRef.current) {
      pointsRef.current.material.uniforms.time.value = state.clock.elapsedTime;
      // Very slow global rotation of the entire disk
      pointsRef.current.rotation.y = state.clock.elapsedTime * 0.002;
    }
  });

  return (
    <group rotation={[0.2, 0, 0]}>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={PARTICLE_COUNT} array={particles.positions} itemSize={3} />
          <bufferAttribute attach="attributes-aColor" count={PARTICLE_COUNT} array={particles.colors} itemSize={3} />
          <bufferAttribute attach="attributes-aRadius" count={PARTICLE_COUNT} array={particles.radii} itemSize={1} />
          <bufferAttribute attach="attributes-aAngle" count={PARTICLE_COUNT} array={particles.angles} itemSize={1} />
          <bufferAttribute attach="attributes-aSize" count={PARTICLE_COUNT} array={particles.sizes} itemSize={1} />
          <bufferAttribute attach="attributes-aSpeedOffset" count={PARTICLE_COUNT} array={particles.speeds} itemSize={1} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={accretionDiskShader.vertexShader}
          fragmentShader={accretionDiskShader.fragmentShader}
          uniforms={accretionDiskShader.uniforms}
          transparent={true}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  );
}

// Gravitational Lensing effect (approximate with a custom sphere)
const BlackHoleCore = () => {
  const haloShader = {
    uniforms: {
      color: { value: new THREE.Color("#fb923c") },
      viewVector: { value: new THREE.Vector3() },
      power: { value: 6.0 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWPosition;
      void main() {
        vWPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      uniform float power;
      varying vec3 vNormal;
      varying vec3 vWPosition;
      void main() {
        // Calculate fresnel glow
        vec3 viewDir = normalize(cameraPosition - vWPosition);
        float fresnel = 1.0 - max(dot(vNormal, viewDir), 0.0);
        fresnel = pow(fresnel, power);
        
        // Inner rim is intensely bright, out edges fade
        gl_FragColor = vec4(color * fresnel * 2.0, fresnel * 0.9);
      }
    `
  };

  return (
    <group>
      {/* The Event Horizon (Pure Black) */}
      <Sphere args={[BH_RADIUS, 64, 64]}>
        <meshBasicMaterial color="#000000" toneMapped={false} />
      </Sphere>

      {/* Photon Sphere / Gravitational Lensing Edge (Glow rim inside/around event horizon) */}
      <Sphere args={[BH_RADIUS * 1.08, 64, 64]}>
        <shaderMaterial
          uniforms={haloShader.uniforms}
          vertexShader={haloShader.vertexShader}
          fragmentShader={haloShader.fragmentShader}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </Sphere>
      
      <Sphere args={[BH_RADIUS * 1.25, 64, 64]}>
        <shaderMaterial
          uniforms={{
            color: { value: new THREE.Color("#0284c7") },
            power: { value: 2.5 }
          }}
          vertexShader={haloShader.vertexShader}
          fragmentShader={haloShader.fragmentShader}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </Sphere>
    </group>
  );
};

// ── Distant Planets ────────────────────────────────────────────────────────

const DistantPlanets = () => {
  const planets = useMemo(() => {
    const arr = [];
    const sizes = [150, 420, 230];
    const positions = [
      [-2200, 800, -3500],
      [2800, -1100, -4200],
      [-800, -1800, -2000]
    ];
    const colors = ["#bae6fd", "#fca5a5", "#d8b4fe"];
    for (let i = 0; i < 3; i++) {
      arr.push({ pos: positions[i], r: sizes[i], color: colors[i] });
    }
    return arr;
  }, []);

  return (
    <group>
      {planets.map((p, i) => (
        <group key={i} position={p.pos}>
          {/* Planet body */}
          <Sphere args={[1, 64, 64]} scale={p.r}>
            <meshStandardMaterial color={p.color} metalness={0.1} roughness={0.8} />
          </Sphere>
          {/* Atmospheric rim, simulating glowing gas giant */}
          <Sphere args={[1, 64, 64]} scale={p.r * 1.05}>
            <shaderMaterial
              uniforms={{
                color: { value: new THREE.Color(p.color).multiplyScalar(0.8) },
                power: { value: 7.0 } // Soft edge
              }}
              vertexShader={`
                varying vec3 vNormal;
                varying vec3 vWPosition;
                void main() {
                  vWPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                  vNormal = normalize(normalMatrix * normal);
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `}
              fragmentShader={`
                uniform vec3 color;
                uniform float power;
                varying vec3 vNormal;
                varying vec3 vWPosition;
                void main() {
                  vec3 viewDir = normalize(cameraPosition - vWPosition);
                  float fresnel = max(dot(vNormal, viewDir), 0.0);
                  
                  // Inverse fresnel so edge glows
                  fresnel = 1.0 - fresnel;
                  gl_FragColor = vec4(color * fresnel * 2.0, pow(fresnel, power) * 0.85);
                }
              `}
              transparent={true}
              side={THREE.BackSide}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </Sphere>
          {/* Local illumination so planet appears lit like a crescent from the black hole */}
        </group>
      ))}
    </group>
  );
};

function StarshipExplorer() {
  const shipRef = useRef();

  useFrame((state) => {
    if (!shipRef.current) return;
    const t = state.clock.elapsedTime * 0.05; // Slow orbit time
    const r = BH_RADIUS * 22; // Very far orbit
    
    const x = Math.cos(t) * r;
    const z = Math.sin(t) * r;
    const y = Math.sin(t * 1.5) * 400; // Slight orbital inclination / vertical movement

    shipRef.current.position.set(x, y, z);
    
    // Look along the tangent
    const nextT = t + 0.01;
    const nextX = Math.cos(nextT) * r;
    const nextZ = Math.sin(nextT) * r;
    const nextY = Math.sin(nextT * 1.5) * 400;
    
    shipRef.current.lookAt(new THREE.Vector3(nextX, nextY, nextZ));
  });

  return (
    <group ref={shipRef}>
      <Trail width={4} length={80} color="#ffffff" attenuation={(w) => w * w * w} decay={1.1}>
        <mesh position={[0, 0, 0]}>
          <sphereGeometry args={[8, 16, 16]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
      </Trail>
      {/* Intense glow matching a tiny star/engine output */}
      <pointLight color="#ffffff" intensity={12} distance={1500} decay={2} />
    </group>
  );
}

function DeepSpaceNebula({ seed }) {
  const groupRef = useRef();

  const nebulaLayers = useMemo(() => {
    const rng = createRng(seed ^ 0x5a1b);
    return Array.from({ length: 12 }, (_, index) => ({ // Increased amount of nebulas
      id: `nebula-${index}`,
      texture: generateNebulaTexture(200 + rng() * 120, seed + index * 101),
      position: [
        (rng() - 0.5) * 8000,
        (rng() - 0.5) * 4000,
        -3000 - rng() * 14000, // pushed further back
      ],
      scale: 5000 + rng() * 4000, // scaled up for distance
      opacity: 0.15 + rng() * 0.15,
    }));
  }, [seed]);

  const galaxyBand = useMemo(() => generateGalaxyBandTexture(seed + 19), [seed]);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.z += delta * 0.0001; // slower drift
      groupRef.current.rotation.y += delta * 0.0002;
    }
  });

  return (
    <group ref={groupRef}>
      {nebulaLayers.map((layer) => (
        <sprite key={layer.id} position={layer.position} scale={[layer.scale, layer.scale, 1]}>
          <spriteMaterial
            map={layer.texture}
            transparent
            opacity={layer.opacity * 0.5} // Lower opacity so bloom does not square it
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            /* DO NOT multiply color on low alpha sprite textures if bloom threshold is aggressive to avoid quad artifacts */
          />
        </sprite>
      ))}

      <group rotation={[0.4, -0.2, -0.1]}>
        <sprite position={[0, 0, -6500]} scale={[12000, 3500, 1]}>
          <spriteMaterial
            map={galaxyBand}
            transparent
            opacity={0.16}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      </group>
    </group>
  );
}

// ── Cinematic Camera ───────────────────────────────────────────────────────
// 3rd Person Follow over the ship

function CinematicDriftCamera() {
  const { camera } = useThree();
  const targetLook = useMemo(() => new THREE.Vector3(0, 0, 0), []);

  useFrame((state) => {
    // Make camera follow behind the ship
    const t = state.clock.elapsedTime * 0.05;
    const r = BH_RADIUS * 22; // Must match StarshipExplorer orbit radius
    
    // We want the ship to orbit the black hole, and we want to view from behind and above the ship.
    // By lagging the angle slightly and increasing the radius, we stay "over the shoulder".
    const lagAngle = t - 0.025; 
    const camRadius = r * 1.05; // 5% further out than the ship
    
    const camOffsetX = Math.cos(lagAngle) * camRadius;
    const camOffsetZ = Math.sin(lagAngle) * camRadius;
    const shipY = Math.sin(t * 1.5) * 400;
    const camOffsetY = shipY + 120; // Hover closely above
    
    camera.position.lerp(new THREE.Vector3(camOffsetX, camOffsetY, camOffsetZ), 0.04);
    
    // Look directly through the space towards the black hole, passing by the ship slightly
    targetLook.set(0, 0, 0); // Always aim generally toward the huge black hole
    // Add subtle camera sway
    targetLook.x += Math.sin(state.clock.elapsedTime * 0.1) * 60;
    targetLook.y += Math.cos(state.clock.elapsedTime * 0.15) * 60;

    camera.lookAt(targetLook);
  });

  return null;
}

export default function GlobalStarMapBackground() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        background: "radial-gradient(circle at 50% 50%, #0c0812 0%, #030305 60%, #000000 100%)",
      }}
    >
      <Canvas
        camera={{ position: [0, 800, 4500], fov: 60, near: 10, far: 20000 }}
        gl={{ powerPreference: "high-performance", alpha: true, antialias: false, stencil: false, depth: true }}
        dpr={[1, 1.5]}
      >
        {/* Core lighting */}
        <ambientLight intensity={0.01} />
        <pointLight position={[0, 0, 0]} color="#fff7ed" intensity={5} distance={10000} decay={1.2} />

        {/* Central Black Hole & Accretion Disk */}
        <BlackHoleCore />
        <AccretionDisk />
        <StarshipExplorer />
        <DistantPlanets />

        {/* Deep Space Background */}
        <group rotation={[-0.3, 0.5, 0]}>
          <Stars radius={2500} depth={500} count={9000} factor={8} saturation={0.5} fade speed={0.5} />
          <Stars radius={6000} depth={3000} count={12000} factor={16} saturation={0.9} fade speed={0.1} color="#fca5a5" />
        </group>
        <DeepSpaceNebula seed={88} />
        
        <CinematicDriftCamera />

        {/* Intense Post Processing for Sci-Fi Cinematic Look */}
        <EffectComposer disableNormalPass multisampling={0}>
          <Bloom 
            luminanceThreshold={0.12} 
            luminanceSmoothing={0.9} 
            intensity={3.2} // Very high intensity for the blazing disk
            mipmapBlur 
          />
          <ChromaticAberration
            blendFunction={BlendFunction.NORMAL}
            offset={[0.0015, 0.0015]}
          />
          <Noise opacity={0.035} blendFunction={BlendFunction.OVERLAY} />
          <Vignette eskil={false} offset={0.3} darkness={1.2} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
