import React, { useState, useEffect } from "react";
import { Sphere, Torus } from "@react-three/drei";
import { generatePlanetTextureAsync } from "./universeGenerators";

export default function TexturedPlanet({ seed, p }) {
  const [tex, setTex] = useState(null);

  useEffect(() => {
    let active = true;
    generatePlanetTextureAsync(p.hue, p.sat, seed, 512, p.isSun).then((t) => {
      if (active) setTex(t);
    });
    return () => { active = false; };
  }, [p.hue, p.sat, seed, p.isSun]);

  return (
    <group position={p.pos}>
      <Sphere args={[1, 64, 64]} scale={p.scale}>
        {p.isSun ? (
          <meshBasicMaterial 
            map={tex || null} 
            color={tex ? "white" : p.color} 
            toneMapped={false} 
          />
        ) : (
          <meshStandardMaterial 
            map={tex || null} 
            color={tex ? "white" : p.color} 
            roughness={0.8} 
            metalness={0.2} 
          />
        )}
      </Sphere>
      {p.isSun && (
        <pointLight color={p.color} intensity={0.8} distance={150} decay={1.5} />
      )}
      {p.hasRing && !p.isSun && (
         <Torus args={[1.5, 0.05, 8, 48]} scale={p.scale} rotation={[Math.PI / 3, 0, 0]}>
           <meshStandardMaterial color={p.color} transparent opacity={0.6} />
         </Torus>
      )}
    </group>
  );
}
