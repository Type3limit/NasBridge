import * as THREE from "three";
import { mkRng } from "./universeGenerators";

export function generateNebulaTexture(hue, seed) {
  const S = 512, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const x = c.getContext("2d");
  const rng = mkRng(seed);
  for (let i = 0; i < 5; i++) {
    const cx = S * (0.2 + rng() * 0.6), cy = S * (0.2 + rng() * 0.6);
    const r = S * (0.2 + rng() * 0.35);
    const hs = (rng() - 0.5) * 60;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `hsla(${hue + hs}, 80%, 65%, ${0.35 + rng() * 0.2})`);
    g.addColorStop(0.4, `hsla(${hue + hs + 15}, 65%, 40%, ${0.20 + rng() * 0.1})`);
    g.addColorStop(0.75, `hsla(${hue + hs - 10}, 40%, 25%, ${0.08 + rng() * 0.05})`);
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
  }
  return new THREE.CanvasTexture(c);
}

export function generateGalaxyBandTexture(seed) {
  const W = 1024, H = 256, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const rng = mkRng(seed);
  for (let i = 0; i < 6; i++) {
    const cy = H * (0.3 + rng() * 0.4);
    const bandH = H * (0.2 + rng() * 0.3);
    const hue = 220 + rng() * 50;
    const g = x.createLinearGradient(0, cy - bandH, 0, cy + bandH);
    g.addColorStop(0, "hsla(0,0%,0%,0)");
    g.addColorStop(0.3, `hsla(${hue}, 60%, 55%, ${0.12 + rng() * 0.08})`);
    g.addColorStop(0.5, `hsla(${hue + 15}, 80%, 75%, ${0.20 + rng() * 0.15})`);
    g.addColorStop(0.7, `hsla(${hue - 15}, 60%, 45%, ${0.12 + rng() * 0.08})`);
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  for (let i = 0; i < 600; i++) {
    const px = rng() * W, py = H * 0.1 + rng() * H * 0.8;
    const a = 0.3 + rng() * 0.6;
    const sz = 0.5 + rng() * 2;
    x.fillStyle = `rgba(220,230,255,${a})`;
    x.fillRect(px, py, sz, sz);
  }
  return new THREE.CanvasTexture(c);
}
