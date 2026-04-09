import { useEffect, useRef, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sphere, Trail, Text, Billboard, PointMaterial, Points } from "@react-three/drei";
import * as THREE from "three";

/* ═══════════════════════════════════════════════════════════════════
   行星 & 路由配置
   ═══════════════════════════════════════════════════════════════════ */
const P = {
  prepareInput:    { label: "解析输入",   hue: 195, sat: 75 },
  prepareContext:  { label: "准备上下文", hue: 220, sat: 70 },
  command:         { label: "指令处理",   hue: 155, sat: 65 },
  recovery:        { label: "会话恢复",   hue: 42,  sat: 72 },
  delegateResolve: { label: "委托解析",   hue: 270, sat: 68 },
  delegateExecute: { label: "委托执行",   hue: 285, sat: 70 },
  visionCollect:   { label: "图片采集",   hue: 330, sat: 65 },
  visionBuild:     { label: "多模态构建", hue: 350, sat: 68 },
  visionAnswer:    { label: "视觉回答",   hue: 45,  sat: 70 },
  textPlan:        { label: "规划策略",   hue: 275, sat: 72 },
  textTools:       { label: "工具调用",   hue: 28,  sat: 78 },
  textAnswer:      { label: "生成回复",   hue: 160, sat: 70 },
};

const ROUTE_ORDER = {
  text:      ["prepareInput","prepareContext","textPlan","textTools","textAnswer"],
  textTools: ["prepareInput","prepareContext","textPlan","textTools","textAnswer"],
  vision:    ["prepareInput","prepareContext","visionCollect","visionBuild","visionAnswer"],
  command:   ["prepareInput","command"],
  recovery:  ["prepareInput","recovery"],
  delegate:  ["prepareInput","delegateResolve","delegateExecute"],
};

/* ═══════════════════════════════════════════════════════════════════
   常量
   ═══════════════════════════════════════════════════════════════════ */
const NODE_GAP       = 6;
const R_ACTIVE       = 1.20;
const R_DONE         = 0.56;
const R_PEND         = 0.42;
const ORBIT_RX       = 2.8;
const ORBIT_RZ       = 1.4;
const ORBIT_TILT     = -15;
const LIGHT_SPEED    = 0.012;
const WARP_FRAMES    = 160;
const P_DEPART       = 0.20;
const P_CRUISE       = 0.55;
const DEPART_SPIRAL  = 2.2;
const ARRIVE_SPIRAL  = 2.2;
const CAM_LERP       = 0.050;   // 跟拍响应速度
const PLANET_ROT     = 0.004;
const CAM_HEIGHT     = 2.8;     // 跟拍相机: 探针正上方高度
const CAM_HIGH_WIDE  = 3.5;     // 巡航段相机高度
const CAM_BACK_WIDE  = 2.2;     // 巡航段向后偏移
const STAR_COUNT     = 1500;

/* ─── 工具 ─────────────────────────────────────────────────────── */
function hslToRGB(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return new THREE.Color(f(0), f(8), f(4));
}

function getNodeStatus(nodeId, gs) {
  if (gs.activeNode === nodeId) return "active";
  const h = Array.isArray(gs.nodeHistory)
    ? gs.nodeHistory.slice().reverse().find(e => e.node === nodeId) : null;
  if (h?.status === "completed") return "done";
  if (h?.status === "failed") return "failed";
  return "pending";
}

function nodeRadius(status) {
  return status === "active" ? R_ACTIVE : status === "done" ? R_DONE : R_PEND;
}

function mkRng(seed) {
  let s = Math.abs((seed | 0)) || 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function computeWorldLayout(route, seed) {
  const rng = mkRng(seed ^ 0x1234);
  const order = ROUTE_ORDER[route] || ROUTE_ORDER.text;
  const gap = NODE_GAP + (rng() - 0.5) * 1.5;
  return order.map((id, i) => ({
    id,
    x: i * gap,
    y: Math.sin(i * 1.1 + rng() * 3) * (0.4 + rng() * 0.5),
    z: Math.cos(i * 0.8 + rng() * 3) * (0.2 + rng() * 0.5),
  }));
}

/* ─── 缓动 ─────────────────────────────────────────────────────── */
function easeOutCubic(t)   { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t)    { return t * t * t; }
function smoothstep(t)     { return t * t * (3 - 2 * t); }
function easeInOutQuart(t) {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

/* ─── 程序化噪声 ────────────────────────────────────────────────── */
function _sn(x, y) {
  const d = x * 12.9898 + y * 78.233;
  const s = Math.sin(d) * 43758.5453123;
  return s - Math.floor(s);
}
function _noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = _sn(ix, iy), b = _sn(ix + 1, iy);
  const c = _sn(ix, iy + 1), d = _sn(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function _fbm(x, y, o) {
  let v = 0, a = 0.5;
  for (let i = 0; i < (o || 4); i++) { v += a * _noise2(x, y); x *= 2.03; y *= 2.03; a *= 0.5; }
  return v;
}

/* ─── HSL→RGB 数组 ─────────────────────────────────────────────── */
function hslArr(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/* ─── 程序化行星纹理 ───────────────────────────────────────────── */
function generatePlanetTexture(hue, sat, seed) {
  const S = 512, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const x = c.getContext("2d");
  const rng = mkRng(seed);
  const seedX = rng() * 200, seedY = rng() * 200;
  const styleRoll = rng();
  const TAU = Math.PI * 2;

  /* ── 每种行星类型的多色板 (H, S%, L%) ──────────────────── */
  const type = styleRoll < 0.25 ? 0 : styleRoll < 0.50 ? 1 : styleRoll < 0.75 ? 2 : 3;
  const palettes = [
    // 0: 气态巨行星 — 暖色带状 (木星/土星)
    [
      [hue - 32, Math.min(100, sat + 22), 14],
      [hue - 12, Math.min(100, sat + 18), 32],
      [hue +  5, Math.max(30, sat -  5), 52],
      [hue + 24, Math.min(100, sat + 14), 68],
      [hue + 40, Math.min(100, sat + 25), 42],
      [hue - 18, Math.min(100, sat + 20), 24],
    ],
    // 1: 熔岩/岩石行星 — 裂缝与高温核心
    [
      [hue - 30, Math.min(100, sat + 10),  7],
      [hue - 15, Math.min(100, sat + 18), 17],
      [hue,      Math.min(100, sat + 28), 30],
      [hue + 18, Math.min(100, sat + 38), 50],
      [hue + 32, Math.min(100, sat + 28), 68],
      [hue +  8, Math.min(100, sat + 12), 22],
    ],
    // 2: 冰雪/海洋行星 — 深蓝到亮白
    [
      [hue - 22, Math.max(20, sat - 12), 22],
      [hue,      sat, 46],
      [hue + 14, Math.min(100, sat + 10), 62],
      [hue + 28, Math.max(12, sat - 22), 80],
      [hue - 10, Math.min(100, sat + 16), 36],
      [hue + 20, Math.max(8,  sat - 32), 92],
    ],
    // 3: 能量漩涡/异域 — 深紫到霓虹
    [
      [hue - 48, Math.min(100, sat + 18), 10],
      [hue - 22, Math.min(100, sat + 28), 26],
      [hue,      Math.min(100, sat + 30), 46],
      [hue + 38, Math.min(100, sat + 35), 62],
      [hue + 65, Math.min(100, sat + 18), 44],
      [hue + 95, Math.min(100, sat +  8), 20],
    ],
  ];
  const pal = palettes[type];

  /* ── 逐像素球面采样 ─────────────────────────────────────── */
  const imgData = x.createImageData(S, S);
  const dd = imgData.data;

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = px / S, v = py / S;
      const theta = u * TAU;
      const phi   = v * Math.PI;
      const sx = Math.sin(phi) * Math.cos(theta);
      const sy = Math.sin(phi) * Math.sin(theta);
      const sz = Math.cos(phi);

      let n;
      if (type === 0) {
        // 气态: 清晰纬度带 + 湍流
        const band = Math.cos(sz * 8.5 * Math.PI + _fbm(sx * 3 + seedX, sy * 3 + seedY, 4) * 7.5) * 0.5 + 0.5;
        const turb = _fbm(sx * 5 + seedX + 33, sy * 5 + sz * 3 + seedY + 17, 5) * 0.38;
        n = band * 0.68 + turb * 0.32;
      } else if (type === 1) {
        // 熔岩/岩石: 脊型噪声 (裂缝 + 熔岩流)
        const ridge0 = 1.0 - Math.abs(_fbm(sx * 3 + seedX, sy * 3 + sz * 2 + seedY, 4) * 2 - 1);
        const ridge1 = 1.0 - Math.abs(_fbm(sx * 6 + seedX + 55, sy * 6 + sz * 4 + seedY + 33, 3) * 2 - 1);
        const base   = _fbm(sx * 2 + seedX + 7, sy * 2 + sz + seedY + 11, 3);
        n = base * 0.30 + ridge0 * ridge0 * 0.45 + ridge1 * 0.25;
        n = Math.pow(Math.max(0, n), 0.72);
      } else if (type === 2) {
        // 冰雪/海洋: 平滑大陆 + 极冠
        const smooth = _fbm(sx * 2 + seedX, sy * 2 + sz + seedY, 5);
        const polar  = Math.abs(sz);
        n = smooth * (1 - polar * 0.4) + polar * 0.62;
        n = n * 0.78 + _fbm(sx * 8 + seedX + 88, sy * 8 + sz * 5 + seedY + 44, 3) * 0.22;
      } else {
        // 能量漩涡
        const ang  = Math.atan2(sy, sx);
        const dist = Math.acos(Math.max(-1, Math.min(1, sz)));
        const warp = _fbm(Math.cos(ang) * 2 + seedX, Math.sin(ang) * 2 + seedY, 3) * 2.8;
        n = _fbm(
          Math.cos(ang + dist * 6 + warp) * 2.5 + seedX,
          Math.sin(ang + dist * 6 + warp) * 2.5 + seedY, 6
        );
      }

      n = Math.max(0, Math.min(1, n));

      /* 色板多色插值 */
      const palPos = n * (pal.length - 1);
      const palI   = Math.min(Math.floor(palPos), pal.length - 2);
      const palF   = palPos - palI;
      const c0 = pal[palI], c1 = pal[palI + 1];
      const lH = c0[0] + (c1[0] - c0[0]) * palF;
      const lS = c0[1] + (c1[1] - c0[1]) * palF;
      const lL = c0[2] + (c1[2] - c0[2]) * palF;
      const [r, g, b] = hslArr(lH, lS, lL);
      const idx = (py * S + px) * 4;
      dd[idx] = r; dd[idx + 1] = g; dd[idx + 2] = b; dd[idx + 3] = 255;
    }
  }
  x.putImageData(imgData, 0, 0);

  /* ── 光照层: 侧向恒星照明 ─────────────────────────────────── */
  const shine = x.createRadialGradient(S * 0.28, S * 0.25, 0, S * 0.38, S * 0.35, S * 0.82);
  shine.addColorStop(0,    `hsla(${hue + 30}, ${Math.min(100, sat + 15)}%, 96%, 0.38)`);
  shine.addColorStop(0.25, `hsla(${hue + 15}, ${sat}%, 72%, 0.14)`);
  shine.addColorStop(0.55, "hsla(0,0%,0%,0)");
  shine.addColorStop(1,    `hsla(${hue - 25}, ${sat}%, 4%, 0.30)`);
  x.fillStyle = shine; x.fillRect(0, 0, S, S);

  /* ── 极地大气光晕 ─────────────────────────────────────────── */
  const pg = x.createLinearGradient(0, 0, 0, S);
  pg.addColorStop(0,    `hsla(${hue + 35}, ${Math.min(100, sat + 12)}%, 80%, 0.38)`);
  pg.addColorStop(0.18, "hsla(0,0%,0%,0)");
  pg.addColorStop(0.82, "hsla(0,0%,0%,0)");
  pg.addColorStop(1,    `hsla(${hue - 18}, ${Math.min(100, sat + 10)}%, 62%, 0.30)`);
  x.fillStyle = pg; x.fillRect(0, 0, S, S);

  /* ── 地表特征: 风暴/冰盖/火山口 ──────────────────────────── */
  const feats = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < feats; i++) {
    const fx  = rng() * S;
    const fy  = S * 0.15 + rng() * S * 0.70;
    const fr  = 14 + rng() * 48;
    const fhs = (rng() - 0.5) * 70;
    const fls = 20 + rng() * 40;
    const fg  = x.createRadialGradient(fx, fy, 0, fx, fy, fr);
    fg.addColorStop(0,    `hsla(${hue + fhs}, ${Math.min(100, sat + 28)}%, ${fls}%, ${0.55 + rng() * 0.32})`);
    fg.addColorStop(0.45, `hsla(${hue + fhs * 0.5}, ${sat}%, ${fls * 0.55}%, ${0.14 + rng() * 0.12})`);
    fg.addColorStop(1,    "hsla(0,0%,0%,0)");
    x.fillStyle = fg;
    x.beginPath();
    x.ellipse(fx, fy, fr * (0.55 + rng() * 0.62), fr * (0.28 + rng() * 0.42), rng() * Math.PI, 0, TAU);
    x.fill();
  }

  return new THREE.CanvasTexture(c);
}

/* ─── 行星辉光 Sprite 纹理 ─────────────────────────────────────── */
function generateGlowTex(hue, sat) {
  const S = 128, cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d");
  const half = S / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0.00, `hsla(${hue + 15}, ${Math.min(100, sat + 15)}%, 98%, 1.0)`);
  g.addColorStop(0.08, `hsla(${hue + 8},  ${Math.min(100, sat + 8)}%,  90%, 0.88)`);
  g.addColorStop(0.22, `hsla(${hue},      ${sat}%,                      72%, 0.50)`);
  g.addColorStop(0.42, `hsla(${hue - 5},  ${Math.max(40, sat - 8)}%,   50%, 0.20)`);
  g.addColorStop(0.65, `hsla(${hue - 12}, ${Math.max(30, sat - 20)}%,  28%, 0.06)`);
  g.addColorStop(0.85, `hsla(${hue - 18}, ${Math.max(20, sat - 30)}%,  14%, 0.02)`);
  g.addColorStop(1.00, "hsla(0, 0%, 0%, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

/* ─── 星云纹理 ─────────────────────────────────────────────────── */
function generateNebulaTexture(hue, seed) {
  const S = 192, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const x = c.getContext("2d");
  const rng = mkRng(seed);
  /* 多层径向渐变叠加，更浓郁 */
  for (let i = 0; i < 5; i++) {
    const cx = S * (0.2 + rng() * 0.6), cy = S * (0.2 + rng() * 0.6);
    const r = S * (0.2 + rng() * 0.35);
    const hs = (rng() - 0.5) * 60;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `hsla(${hue + hs}, 55%, 50%, ${0.22 + rng() * 0.18})`);
    g.addColorStop(0.4, `hsla(${hue + hs + 15}, 45%, 35%, ${0.10 + rng() * 0.08})`);
    g.addColorStop(0.75, `hsla(${hue + hs - 10}, 30%, 22%, ${0.03 + rng() * 0.04})`);
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
  }
  return new THREE.CanvasTexture(c);
}

/* ─── 银河/星河带纹理 ─────────────────────────────────────────── */
function generateGalaxyBandTexture(seed) {
  const W = 512, H = 128, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const rng = mkRng(seed);
  /* 多条水平渐变带叠加 */
  for (let i = 0; i < 4; i++) {
    const cy = H * (0.3 + rng() * 0.4);
    const bandH = H * (0.15 + rng() * 0.25);
    const hue = 200 + rng() * 60;
    const g = x.createLinearGradient(0, cy - bandH, 0, cy + bandH);
    g.addColorStop(0, "hsla(0,0%,0%,0)");
    g.addColorStop(0.3, `hsla(${hue}, 40%, 45%, ${0.06 + rng() * 0.06})`);
    g.addColorStop(0.5, `hsla(${hue + 10}, 50%, 55%, ${0.12 + rng() * 0.10})`);
    g.addColorStop(0.7, `hsla(${hue - 10}, 40%, 40%, ${0.06 + rng() * 0.06})`);
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  /* 散布微小亮点模拟密集星尘 */
  for (let i = 0; i < 300; i++) {
    const px = rng() * W, py = H * 0.2 + rng() * H * 0.6;
    const a = 0.15 + rng() * 0.45;
    const sz = 0.5 + rng() * 1.5;
    x.fillStyle = `rgba(200,215,255,${a})`;
    x.fillRect(px, py, sz, sz);
  }
  return new THREE.CanvasTexture(c);
}

/* ═══════════════════════════════════════════════════════════════════
   星场背景
   ═══════════════════════════════════════════════════════════════════ */
function Starfield({ seed = 1 }) {
  const groupRef = useRef();
  const layers = useMemo(() => {
    const rng = mkRng(seed ^ 0xBEEF);
    const spread = 42;

    function makeLayer(count) {
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        arr[i * 3]     = (rng() - 0.5) * spread;
        arr[i * 3 + 1] = (rng() - 0.5) * spread;
        arr[i * 3 + 2] = (rng() - 0.5) * spread;
      }
      return arr;
    }

    const warmT = rng(), coolT = rng();
    return {
      pos1: makeLayer(1400),
      pos2: makeLayer(550),
      pos3: makeLayer(200),
      pos4: makeLayer(60),
      color1: new THREE.Color(0.55, 0.64, 0.82),
      color2: new THREE.Color(0.82 + warmT * 0.12, 0.84 + warmT * 0.06, 0.78),
      color3: new THREE.Color(0.7 + coolT * 0.3, 0.82, 1.0),
      color4: new THREE.Color(1.0, 0.96 + warmT * 0.04, 0.82 + warmT * 0.1),
    };
  }, [seed]);

  /* 缓慢旋转，产生深空动态感 */
  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.00008;
      groupRef.current.rotation.x += 0.00003;
    }
  });

  return (
    <group ref={groupRef}>
      <Points positions={layers.pos1} stride={3}>
        <PointMaterial transparent size={0.025} sizeAttenuation color={layers.color1} depthWrite={false} opacity={0.30} />
      </Points>
      <Points positions={layers.pos2} stride={3}>
        <PointMaterial transparent size={0.06} sizeAttenuation color={layers.color2} depthWrite={false} opacity={0.55} />
      </Points>
      <Points positions={layers.pos3} stride={3}>
        <PointMaterial transparent size={0.12} sizeAttenuation color={layers.color3} depthWrite={false} opacity={0.80} />
      </Points>
      <Points positions={layers.pos4} stride={3}>
        <PointMaterial transparent size={0.22} sizeAttenuation color={layers.color4} depthWrite={false} opacity={0.95} />
      </Points>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   星云背景
   ═══════════════════════════════════════════════════════════════════ */
function NebulaCloud({ seed }) {
  const groupRef = useRef();
  const { clouds, band } = useMemo(() => {
    const rng = mkRng(seed ^ 0xDEB0);
    const cls = Array.from({ length: 10 }, (_, i) => ({
      tex: generateNebulaTexture(rng() * 360, (seed + i * 7919) | 0),
      position: [(rng() - 0.5) * 32, (rng() - 0.5) * 14, -5 - rng() * 18],
      scale: 10 + rng() * 18,
      opacity: 0.32 + rng() * 0.32,
    }));
    const bandTex = generateGalaxyBandTexture((seed ^ 0xF00D) | 0);
    const bandAngle = -15 + rng() * 30; // 倾斜角度
    const bandY = (rng() - 0.5) * 4;
    return {
      clouds: cls,
      band: { tex: bandTex, y: bandY, angle: bandAngle },
    };
  }, [seed]);

  /* 星云缓慢飘浮 */
  useFrame(() => {
    if (groupRef.current) {
      const t = Date.now() * 0.00004;
      groupRef.current.position.x = Math.sin(t * 1.7) * 0.3;
      groupRef.current.position.y = Math.cos(t * 1.3) * 0.15;
    }
  });

  return (
    <group ref={groupRef}>
      {clouds.map((c, i) => (
        <sprite key={i} position={c.position} scale={[c.scale, c.scale, 1]}>
          <spriteMaterial map={c.tex} transparent opacity={c.opacity} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>
      ))}
      {/* 银河带 */}
      <group rotation={[0, 0, (band.angle * Math.PI) / 180]} position={[0, band.y, -12]}>
        <sprite scale={[40, 8, 1]}>
          <spriteMaterial map={band.tex} transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>
      </group>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   行星球体
   ═══════════════════════════════════════════════════════════════════ */
function Planet({ id, position, status, pTraits }) {
  const meshRef      = useRef();
  const rimRef       = useRef();
  const coronaRef    = useRef();
  const coronaMatRef = useRef();
  const cfg = P[id];
  if (!cfg) return null;

  const pt  = pTraits || {};
  const hue = cfg.hue + (pt.hueShift || 0);
  const sat = Math.max(35, Math.min(100, cfg.sat + (pt.satBoost || 0)));
  const r   = nodeRadius(status);

  const texture = useMemo(() => {
    let s = 0;
    for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) | 0;
    return generatePlanetTexture(hue, sat, s ^ (pt.texSeed || 0));
  }, [hue, sat, id, pt.texSeed]);

  /* 辉光 Sprite 纹理 — 以行星自身色调生成径向扩散光 */
  const glowTex = useMemo(() => generateGlowTex(hue, sat), [hue, sat]);

  const color = useMemo(() => {
    if (status === "pending") return hslToRGB(hue, Math.max(10, sat - 40), 18);
    return new THREE.Color("#ffffff");
  }, [status, hue, sat]);

  const emissiveColor = useMemo(() => {
    if (status === "pending") return hslToRGB(hue, Math.max(8, sat - 50), 8);
    return hslToRGB(hue, sat, 50 + (pt.lightness || 0));
  }, [status, hue, sat, pt.lightness]);

  /* 霓虹边缘色 — 高饱和度亮色 */
  const rimColor = useMemo(
    () => hslToRGB(hue, Math.min(100, sat + 12), 82),
    [hue, sat]
  );

  const rotAxis = useMemo(() => new THREE.Vector3(
    pt.rotTiltX || 0, 1, pt.rotTiltZ || 0
  ).normalize(), [pt.rotTiltX, pt.rotTiltZ]);

  useFrame(() => {
    if (meshRef.current) {
      const speed = status === "pending"
        ? (pt.rotSpeed || PLANET_ROT) * 0.3
        : (pt.rotSpeed || PLANET_ROT);
      meshRef.current.rotateOnAxis(rotAxis, speed);
    }
    /* 激活态: 光晕脉动 */
    if (status === "active") {
      const t = Date.now() * 0.0012;
      const pulse = 1 + Math.sin(t) * 0.13 + Math.sin(t * 2.7) * 0.06;
      if (coronaRef.current) coronaRef.current.scale.setScalar(pulse);
      if (coronaMatRef.current) {
        coronaMatRef.current.opacity = 0.78 + Math.sin(t * 1.4) * 0.12;
      }
    }
  });

  /* 光晕尺寸: active 行星扩散到 r*5.5, done 到 r*3.2, pending 微弱 */
  const coronaSize    = status === "active" ? r * 5.5 : status === "done" ? r * 3.2 : r * 1.8;
  const coronaOpacity = status === "active" ? 0.78 : status === "done" ? 0.40 : 0.08;
  const emissiveInt   = status === "active" ? 0.45 : status === "done" ? 0.22 : 0.05;

  return (
    <group position={position}>
      {/* 辉光 corona — Sprite 保证径向柔性扩散，不像球体那样硬边 */}
      <sprite ref={coronaRef} scale={[coronaSize, coronaSize, 1]}>
        <spriteMaterial ref={coronaMatRef} map={glowTex} transparent
          opacity={coronaOpacity}
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </sprite>
      {/* 霓虹边光壳 — 极薄 BackSide，模拟参考 demo 的 neon border */}
      {status !== "pending" && (
        <Sphere ref={rimRef} args={[r * 1.04, 32, 16]}>
          <meshBasicMaterial color={rimColor} transparent
            opacity={status === "active" ? 0.25 : 0.08}
            side={THREE.BackSide} depthWrite={false} blending={THREE.AdditiveBlending} />
        </Sphere>
      )}
      {/* 星球本体 */}
      <Sphere ref={meshRef} args={[r, 72, 36]}>
        <meshStandardMaterial
          map={texture}
          color={color}
          emissive={emissiveColor}
          emissiveIntensity={emissiveInt}
          roughness={pt.roughness ?? 0.60}
          metalness={pt.metalness ?? 0.20}
          transparent={status === "pending"}
          opacity={status === "pending" ? 0.40 : 1}
        />
      </Sphere>
      <Billboard position={[0, -(r + 0.38), 0]}>
        <Text
          fontSize={status === "active" ? 0.22 : 0.16}
          color={status === "pending" ? "#556" : status === "active" ? rimColor : "#8aa"}
          anchorX="center" anchorY="top"
          font={undefined}
          outlineWidth={status === "active" ? 0.015 : 0}
          outlineColor="#000"
        >
          {status === "active" ? `⟨ ${cfg.label} ⟩` : cfg.label}
        </Text>
      </Billboard>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   航线弧
   ═══════════════════════════════════════════════════════════════════ */
function RouteArc({ from, to, lit, arcHeight = 0.6 }) {
  const { geo, glowGeo } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += arcHeight;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    return {
      geo: new THREE.TubeGeometry(curve, 48, lit ? 0.028 : 0.015, 6, false),
      glowGeo: new THREE.TubeGeometry(curve, 48, lit ? 0.12 : 0.06, 6, false),
    };
  }, [from, to, lit, arcHeight]);

  return (
    <group>
      <mesh geometry={geo}>
        <meshBasicMaterial
          color={lit ? "#6699ee" : "#334466"}
          transparent opacity={lit ? 0.55 : 0.15}
          depthWrite={false}
        />
      </mesh>
      <mesh geometry={glowGeo}>
        <meshBasicMaterial color={lit ? "#4488dd" : "#223344"} transparent
          opacity={lit ? 0.07 : 0.025}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   轨道环 — 亮芯 + 外发光管 (参考 CSS3 box-shadow 式辉光)
   ═══════════════════════════════════════════════════════════════════ */
function OrbitRing({ center, rx = ORBIT_RX, rz = ORBIT_RZ, tilt = ORBIT_TILT }) {
  const { lineGeo, glowGeo } = useMemo(() => {
    const tiltR = (tilt * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      const rawX = rx * Math.cos(a);
      const rawZ = rz * Math.sin(a);
      pts.push(new THREE.Vector3(
        rawX * Math.cos(tiltR) - rawZ * Math.sin(tiltR) + center[0],
        center[1],
        rawX * Math.sin(tiltR) + rawZ * Math.cos(tiltR) + center[2]
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true); // closed loop
    return {
      lineGeo: new THREE.BufferGeometry().setFromPoints(pts),
      glowGeo: new THREE.TubeGeometry(curve, 128, 0.045, 6, true),
    };
  }, [center, rx, rz, tilt]);

  const matRef = useRef();
  useFrame(() => {
    if (matRef.current) {
      matRef.current.opacity = 0.06 + Math.sin(Date.now() * 0.0015) * 0.025;
    }
  });

  return (
    <group>
      {/* 明亮细线芯 */}
      <line geometry={lineGeo}>
        <lineBasicMaterial color="#7799dd" transparent opacity={0.35} />
      </line>
      {/* 柔和外发光管 */}
      <mesh geometry={glowGeo}>
        <meshBasicMaterial ref={matRef} color="#5588cc" transparent opacity={0.07}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   航行探针 + 镜头控制
   ═══════════════════════════════════════════════════════════════════ */
function Probe({ worldNodes, gs, orbitRx = ORBIT_RX, orbitRz = ORBIT_RZ, orbitTilt = ORBIT_TILT }) {
  const probeRef = useRef();
  const { camera } = useThree();
  const activeId = gs.activeNode;
  const activeWN = worldNodes.find(n => n.id === activeId);

  const tiltR = (orbitTilt * Math.PI) / 180;

  function orbitPos(angle, cx, cy, cz, rxMul = 1, rzMul = 1) {
    const rawX = orbitRx * rxMul * Math.cos(angle);
    const rawZ = orbitRz * rzMul * Math.sin(angle);
    return {
      x: rawX * Math.cos(tiltR) - rawZ * Math.sin(tiltR) + cx,
      y: cy,
      z: rawX * Math.sin(tiltR) + rawZ * Math.cos(tiltR) + cz,
    };
  }

  const st = useRef({
    camX: 0, camY: CAM_HEIGHT, camZ: 0,
    camTargetX: 0, camTargetY: CAM_HEIGHT, camTargetZ: 0,
    lookX: 0, lookY: 0, lookZ: 0,
    lookTargetX: 0, lookTargetY: 0, lookTargetZ: 0,
    dotX: 0, dotY: 0, dotZ: 0,
    angle: 0,
    orbitCx: 0, orbitCy: 0, orbitCz: 0,
    departCx: 0, departCy: 0, departCz: 0,
    phase: "orbit",
    progress: 0,
    _cruiseSnapped: false,
    _arriveSnapped: false,
    _settleFrames: 999,
    fromX: 0, fromY: 0, fromZ: 0,
    toX: 0, toY: 0, toZ: 0,
    _inited: false,
  });

  const prevActiveId = useRef(null);

  useEffect(() => {
    if (!activeWN) return;
    const s = st.current;
    const ax = activeWN.x, ay = activeWN.y, az = activeWN.z;

    if (!s._inited) {
      s.orbitCx = ax; s.orbitCy = ay; s.orbitCz = az;
      const p = orbitPos(0, ax, ay, az);
      s.dotX = p.x; s.dotY = p.y; s.dotZ = p.z;
      s.camX = p.x;
      s.camY = p.y + CAM_HEIGHT;
      s.camZ = p.z;
      s.camTargetX = s.camX; s.camTargetY = s.camY; s.camTargetZ = s.camZ;
      s.lookX = ax; s.lookY = ay; s.lookZ = az;
      s.lookTargetX = ax; s.lookTargetY = ay; s.lookTargetZ = az;
      s._inited = true;
      prevActiveId.current = activeId;
      camera.position.set(s.camX, s.camY, s.camZ);
      camera.lookAt(ax, ay, az);
      return;
    }

    /* 同一节点 → 忽略 */
    if (activeId === prevActiveId.current) return;
    prevActiveId.current = activeId;

    /* 目标和当前已经重合 → 忽略 */
    if (Math.abs(s.orbitCx - ax) < 0.1 && Math.abs(s.orbitCz - az) < 0.1 && s.phase === "orbit") return;

    /* 从当前探针实际位置出发（无论 orbit/depart/cruise/arrive） */
    s.fromX = s.dotX; s.fromY = s.dotY; s.fromZ = s.dotZ;
    s.departCx = s.orbitCx; s.departCy = s.orbitCy; s.departCz = s.orbitCz;
    s.toX = ax; s.toY = ay; s.toZ = az;
    s.phase = "depart";
    s.progress = 0;
    s._cruiseSnapped = false;
    s._arriveSnapped = false;
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const s = st.current;
    const dp = 1 / WARP_FRAMES;

    if (s.phase === "orbit") {
      s.angle += LIGHT_SPEED;
      const p = orbitPos(s.angle, s.orbitCx, s.orbitCy, s.orbitCz);
      s.dotX = p.x; s.dotY = p.y; s.dotZ = p.z;

      /* 跟拍相机: 探针外侧后上方 (星球反向偏移 + Y抬高), 朝向星球
         这样探针在画面下部可见, 星球巨大填满上方 */
      const awayX = s.dotX - s.orbitCx;
      const awayZ = s.dotZ - s.orbitCz;
      const awayLen = Math.sqrt(awayX * awayX + awayZ * awayZ) || 1;
      const nax = awayX / awayLen, naz = awayZ / awayLen;
      const CAM_BACK_ORBIT = 1.8;
      const CAM_H_ORBIT    = 1.2;
      s.camTargetX = s.dotX + nax * CAM_BACK_ORBIT;
      s.camTargetY = s.dotY + CAM_H_ORBIT;
      s.camTargetZ = s.dotZ + naz * CAM_BACK_ORBIT;
      s.lookTargetX = s.orbitCx;
      s.lookTargetY = s.orbitCy;
      s.lookTargetZ = s.orbitCz;

    } else {
      s.progress = Math.min(1, s.progress + dp);
      const t = s.progress;

      /* ── depart: 从出发星球螺旋放大，逐渐拉向目标方向 ── */
      if (t < P_DEPART) {
        const local = t / P_DEPART;
        const e = easeOutCubic(local);
        const spiralMul = 1 + (DEPART_SPIRAL - 1) * e;
        s.angle += LIGHT_SPEED * (1 + e * 3);
        const p = orbitPos(s.angle, s.departCx, s.departCy, s.departCz, spiralMul, spiralMul);
        // 逐渐混入目标方向，避免 depart→cruise 位置突变
        const blend = e * 0.15;
        s.dotX = p.x * (1 - blend) + s.toX * blend;
        s.dotY = p.y * (1 - blend) + s.toY * blend;
        s.dotZ = p.z * (1 - blend) + s.toZ * blend;

        /* 跟拍: 从出发星球外侧逐渐转向目标方向后方 */
        const awayDx = s.dotX - s.departCx;
        const awayDz = s.dotZ - s.departCz;
        const awayDLen = Math.sqrt(awayDx * awayDx + awayDz * awayDz) || 1;
        const naxx = awayDx / awayDLen, nazz = awayDz / awayDLen;
        const toDx = (s.toX - s.departCx) || 0.001;
        const toDz = (s.toZ - s.departCz) || 0.001;
        const toD  = Math.sqrt(toDx * toDx + toDz * toDz);
        const nfx = toDx / toD, nfz = toDz / toD;
        const height = 1.2 + (CAM_HIGH_WIDE - 1.2) * e;
        const back   = 1.8 + (CAM_BACK_WIDE - 1.8) * e;
        // 从星球外侧朝向到反行进方向的平滑插值
        const nbx = naxx * (1 - e) - nfx * e;
        const nbz = nazz * (1 - e) - nfz * e;
        const nbLen = Math.sqrt(nbx * nbx + nbz * nbz) || 1;
        s.camTargetX = s.dotX + (nbx / nbLen) * back;
        s.camTargetY = s.dotY + height;
        s.camTargetZ = s.dotZ + (nbz / nbLen) * back;
        s.lookTargetX = s.departCx * (1 - e) + s.toX * e;
        s.lookTargetY = s.departCy * (1 - e) + s.toY * e;
        s.lookTargetZ = s.departCz * (1 - e) + s.toZ * e;

      /* ── cruise: 从实际位置平滑飞向目标轨道入口 (不穿透星球) ── */
      } else if (t < P_DEPART + P_CRUISE) {
        if (!s._cruiseSnapped) {
          s._cruiseSnapped = true;
          s.cruiseFromX = s.dotX; s.cruiseFromY = s.dotY; s.cruiseFromZ = s.dotZ;
          /* 轨道入口: 在目标星球外侧、轨道环半径处、朝向出发方向的一点
             确保 arrive 阶段从星球外部开始，探针不会穿透星球 */
          const apDx = s.dotX - s.toX;
          const apDz = s.dotZ - s.toZ;
          const apLen = Math.sqrt(apDx * apDx + apDz * apDz) || 1;
          s._approachX = s.toX + (apDx / apLen) * orbitRx * 1.5;
          s._approachY = s.toY;
          s._approachZ = s.toZ + (apDz / apLen) * orbitRz * 1.5;
        }
        const local = (t - P_DEPART) / P_CRUISE;
        const e = smoothstep(local);
        s.dotX = s.cruiseFromX + (s._approachX - s.cruiseFromX) * e;
        s.dotY = s.cruiseFromY + (s._approachY - s.cruiseFromY) * e + Math.sin(e * Math.PI) * 0.6;
        s.dotZ = s.cruiseFromZ + (s._approachZ - s.cruiseFromZ) * e;
        s.angle += LIGHT_SPEED * (4 - e * 2);  // 逐渐减速

        /* 跟拍: 探针正后方上方 (反行进方向), 看向目标 */
        const fwdX = (s._approachX - s.cruiseFromX) || 0.001;
        const fwdZ = (s._approachZ - s.cruiseFromZ) || 0.001;
        const fwdD = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ);
        const nx = fwdX / fwdD, nz = fwdZ / fwdD;
        s.camTargetX = s.dotX - nx * CAM_BACK_WIDE;
        s.camTargetY = s.dotY + CAM_HIGH_WIDE;
        s.camTargetZ = s.dotZ - nz * CAM_BACK_WIDE;
        s.lookTargetX = s.toX;
        s.lookTargetY = s.toY;
        s.lookTargetZ = s.toZ;

      /* ── arrive: 从实际位置渐入目标星球轨道 ── */
      } else {
        if (!s._arriveSnapped) {
          s._arriveSnapped = true;
          s.arriveFromX = s.dotX; s.arriveFromY = s.dotY; s.arriveFromZ = s.dotZ;
        }
        const local = (t - P_DEPART - P_CRUISE) / (1 - P_DEPART - P_CRUISE);
        const e = easeInOutQuart(local);
        // 轨道目标位置
        const spiralMul = ARRIVE_SPIRAL - (ARRIVE_SPIRAL - 1) * e;
        s.angle += LIGHT_SPEED * (2 - e);  // 逐渐回到正常速
        const op = orbitPos(s.angle, s.toX, s.toY, s.toZ, spiralMul, spiralMul);
        // 从 cruise 终点混合到轨道位置，避免位置跳变
        s.dotX = s.arriveFromX * (1 - e) + op.x * e;
        s.dotY = s.arriveFromY * (1 - e) + op.y * e;
        s.dotZ = s.arriveFromZ * (1 - e) + op.z * e;

        /* 跟拍: 逐渐从反巡航方向过渡到轨道外侧, 始终看向目标星球 */
        const awayX = s.dotX - s.toX;
        const awayZ = s.dotZ - s.toZ;
        const awayLen = Math.sqrt(awayX * awayX + awayZ * awayZ) || 1;
        const nax2 = awayX / awayLen, naz2 = awayZ / awayLen;
        const fwdX2 = (s.toX - (s.arriveFromX||s.dotX)) || 0.001;
        const fwdZ2 = (s.toZ - (s.arriveFromZ||s.dotZ)) || 0.001;
        const fwdD2 = Math.sqrt(fwdX2 * fwdX2 + fwdZ2 * fwdZ2);
        const rfx = fwdX2 / fwdD2, rfz = fwdZ2 / fwdD2;
        // 从「反巡航方向」插值到「星球外侧」
        const bkx = -rfx * (1 - e) + nax2 * e;
        const bkz = -rfz * (1 - e) + naz2 * e;
        const bkLen = Math.sqrt(bkx * bkx + bkz * bkz) || 1;
        const height = CAM_HIGH_WIDE + (1.2 - CAM_HIGH_WIDE) * e;
        const back   = CAM_BACK_WIDE + (1.8 - CAM_BACK_WIDE) * e;
        s.camTargetX = s.dotX + (bkx / bkLen) * back;
        s.camTargetY = s.dotY + height;
        s.camTargetZ = s.dotZ + (bkz / bkLen) * back;
        s.lookTargetX = s.toX;
        s.lookTargetY = s.toY;
        s.lookTargetZ = s.toZ;
      }

      if (t >= 1) {
        s.phase = "orbit";
        s.orbitCx = s.toX; s.orbitCy = s.toY; s.orbitCz = s.toZ;
        s._settleFrames = 0;
      }
    }

    // 镜头平滑
    s.camX += (s.camTargetX - s.camX) * CAM_LERP;
    s.camY += (s.camTargetY - s.camY) * CAM_LERP;
    s.camZ += (s.camTargetZ - s.camZ) * CAM_LERP;
    s.lookX += (s.lookTargetX - s.lookX) * CAM_LERP;
    s.lookY += (s.lookTargetY - s.lookY) * CAM_LERP;
    s.lookZ += (s.lookTargetZ - s.lookZ) * CAM_LERP;

    camera.position.set(s.camX, s.camY, s.camZ);
    camera.lookAt(s.lookX, s.lookY, s.lookZ);

    if (probeRef.current) {
      probeRef.current.position.set(s.dotX, s.dotY, s.dotZ);
    }
  });

  const dotColor = useMemo(() => {
    if (!activeWN) return "#93c5fd";
    const cfg = P[activeWN.id];
    return cfg ? hslToRGB(cfg.hue, cfg.sat, 80) : new THREE.Color("#93c5fd");
  }, [activeWN]);

  /* 闪烁（帧级） */
  const flickerRef = useRef(null);
  const glowRef2 = useRef(null);
  useFrame(() => {
    const t = Date.now() * 0.006;
    const flicker = 0.7 + Math.sin(t * 7.3) * 0.15 + Math.sin(t * 13.1) * 0.1 + Math.random() * 0.05;
    if (flickerRef.current) flickerRef.current.opacity = flicker;
    if (glowRef2.current) glowRef2.current.opacity = flicker * 0.25;
  });

  return (
    <group ref={probeRef}>
      {/* ── 外层: 宽柔大光晕尾焰 (加速时最明显) ── */}
      <Trail width={0.55} length={45} color={dotColor}
        attenuation={(w) => w * w * w * w * w} decay={0.6}>
        <Sphere args={[0.001, 3, 2]}>
          <meshBasicMaterial transparent opacity={0} toneMapped={false} />
        </Sphere>
      </Trail>
      {/* ── 中层: 能量蓝白尾焰 ── */}
      <Trail width={0.20} length={35} color={new THREE.Color(0.7, 0.88, 1.0)}
        attenuation={(w) => w * w * w} decay={0.9}>
        <Sphere args={[0.001, 3, 2]}>
          <meshBasicMaterial transparent opacity={0} toneMapped={false} />
        </Sphere>
      </Trail>
      {/* ── 亮芯: 细亮条尾焰 + 探针本体 ── */}
      <Trail width={0.07} length={22} color={new THREE.Color(1, 1, 1)}
        attenuation={(w) => w * w} decay={1.8}>
        <Sphere args={[0.028, 12, 8]}>
          <meshBasicMaterial ref={flickerRef} color="#ffffff" transparent toneMapped={false} />
        </Sphere>
      </Trail>
      {/* 小辉光 */}
      <Sphere args={[0.10, 8, 6]}>
        <meshBasicMaterial ref={glowRef2} color={dotColor} transparent opacity={0.30}
          depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </Sphere>
      {/* 微弱点光源 */}
      <pointLight color={dotColor} intensity={0.8} distance={4} decay={2} />
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   场景
   ═══════════════════════════════════════════════════════════════════ */
function Scene({ gs, worldNodes, seed }) {
  const activeId = gs.activeNode;

  const traits = useMemo(() => {
    const rng = mkRng(seed ^ 0xCAFE);
    return {
      orbitRx: Math.max(R_ACTIVE + 1.2, ORBIT_RX * (0.85 + rng() * 0.4)),
      orbitRz: Math.max(R_ACTIVE + 0.7, ORBIT_RZ * (0.8 + rng() * 0.5)),
      orbitTilt: ORBIT_TILT + (rng() - 0.5) * 25,
      arcHeights: worldNodes.map(() => 0.3 + rng() * 0.7),
      planets: worldNodes.map(() => ({
        hueShift:  (rng() - 0.5) * 200,   // 全色相轮随机 ±100°
        satBoost:  (rng() - 0.5) * 40,    // 饱和度浮动
        lightness: (rng() - 0.5) * 8,
        roughness: 0.45 + rng() * 0.45,
        metalness: 0.04 + rng() * 0.28,
        rotSpeed:  PLANET_ROT * (0.4 + rng() * 1.4),
        rotTiltX:  (rng() - 0.5) * 0.55,
        rotTiltZ:  (rng() - 0.5) * 0.55,
        pulseSpeed: rng() * 0.002,
        glowScale:  0.02 + rng() * 0.08,
        texSeed:   (rng() * 2147483647) | 0,  // 每局不同纹理类型
      })),
      lightDir: [6 + rng() * 4, 3 + rng() * 4, 4 + rng() * 4],
      accentColor: hslToRGB(rng() * 360, 45, 28),
    };
  }, [seed, worldNodes]);

  const arcs = useMemo(() => {
    const result = [];
    for (let i = 0; i < worldNodes.length - 1; i++) {
      const a = worldNodes[i], b = worldNodes[i + 1];
      const sa = getNodeStatus(a.id, gs), sb = getNodeStatus(b.id, gs);
      const lit = sa !== "pending" && sb !== "pending";
      result.push({ key: `${a.id}-${b.id}`, from: [a.x, a.y, a.z], to: [b.x, b.y, b.z], lit, arcH: traits.arcHeights[i] });
    }
    return result;
  }, [worldNodes, traits, gs.activeNode, gs.nodeHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeWN = worldNodes.find(n => n.id === activeId);

  return (
    <>
      <ambientLight intensity={0.25} />
      <directionalLight position={traits.lightDir} intensity={0.8} color="#c0d4ff" />
      <pointLight position={[-5, 3, -5]} intensity={0.3} color={traits.accentColor} />

      <Starfield seed={seed} />
      <NebulaCloud seed={seed} />

      {activeWN && (
        <OrbitRing center={[activeWN.x, activeWN.y, activeWN.z]}
          rx={traits.orbitRx} rz={traits.orbitRz} tilt={traits.orbitTilt} />
      )}

      {worldNodes.map((n, i) => {
        const status = getNodeStatus(n.id, gs);
        return <Planet key={n.id} id={n.id} position={[n.x, n.y, n.z]} status={status} pTraits={traits.planets[i]} />;
      })}

      <Probe worldNodes={worldNodes} gs={gs}
        orbitRx={traits.orbitRx} orbitRz={traits.orbitRz} orbitTilt={traits.orbitTilt} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   外层容器
   ═══════════════════════════════════════════════════════════════════ */
export function AiStarMapCard({ graphState, elapsedText, subtitle, detailBody }) {
  const containerRef = useRef(null);
  const [visible, setVisible] = useState(true);

  const gs = useMemo(() => graphState || {}, [graphState]);
  const route = gs.route || "text";
  const activeId = gs.activeNode;
  const activeCfg = activeId ? P[activeId] : null;

  const seed = useMemo(() => (Math.random() * 2147483647) | 0, []);
  const worldNodes = useMemo(() => computeWorldLayout(route, seed), [route, seed]);

  /* 从 detailBody 提取关键细节（搜索词、检索阶段等） */
  const hudDetail = useMemo(() => {
    if (!detailBody || typeof detailBody !== "string") return "";
    const lines = detailBody.split("\n").map((l) => l.trim()).filter(Boolean);
    /* 提取 Search Terms 行 */
    const termsIdx = lines.findIndex((l) => /search\s*terms/i.test(l));
    if (termsIdx >= 0) {
      const terms = [];
      for (let i = termsIdx + 1; i < lines.length && lines[i].startsWith("- "); i++) {
        terms.push(lines[i].slice(2).trim());
      }
      if (terms.length) return `检索词: ${terms.join(" | ")}`;
    }
    /* 提取已执行检索 */
    const execIdx = lines.findIndex((l) => /已执行检索/.test(l));
    if (execIdx >= 0) {
      const qs = [];
      for (let i = execIdx + 1; i < lines.length && lines[i].startsWith("- "); i++) {
        qs.push(lines[i].slice(2).trim());
      }
      if (qs.length) return `已检索: ${qs.join(" | ")}`;
    }
    /* 提取 Intent */
    const intentLine = lines.find((l) => /^Intent[：:]/.test(l));
    if (intentLine) return intentLine;
    /* fallback: 第二行（跳过阶段行） */
    return lines[1] || "";
  }, [detailBody]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.05 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="aiStarMapContainer">
      <div className="aiStarMapCanvasWrap">
        <Canvas
          className="aiStarMapCanvas"
          frameloop={visible ? "always" : "never"}
          dpr={[1, 2]}
          camera={{ fov: 50, near: 0.1, far: 100, position: [0, 3, 0] }}
          gl={{ antialias: true, alpha: false, powerPreference: "low-power" }}
          style={{ background: "#020408" }}
          resize={{ debounce: 200 }}
        >
          <Scene gs={gs} worldNodes={worldNodes} seed={seed} />
        </Canvas>

        <div className="hudOverlay">
          <span className="hudCorner hudTL">┌─</span>
          <span className="hudCorner hudTR">─┐</span>
          <span className="hudCorner hudBL">└─</span>
          <span className="hudCorner hudBR">─┘</span>

          {/* 扫描线 */}
          <div className="hudScanLine" />

          {/* 左上: LIVE 指示器 */}
          <div className="hudTagTL">
            <span className="hudTagDot" />
            <span className="hudTagText">LIVE</span>
          </div>

          {/* 右上: 信号强度柱 */}
          <div className="hudSignalGroup">
            <div className="hudSignalBar hudSB1" />
            <div className="hudSignalBar hudSB2" />
            <div className="hudSignalBar hudSB3" />
            <div className="hudSignalBar hudSB4" />
          </div>

          {/* 中心瞄准线 */}
          <div className="hudReticle" />

          {/* 右侧遥测竖条 */}
          <div className="hudTelemetryBar" />

          {/* 左侧遥测竖条 */}
          <div className="hudTelemetryBarL" />

          {/* 底部中心: 当前节点标签 */}
          {activeCfg && (
            <div className="hudBottomCenter">
              <span className="hudBottomLabel">{activeCfg.label.toUpperCase()}</span>
            </div>
          )}
        </div>
      </div>

      <div className="cosmicStatusRow">
        <span className="cosmicStatusLabel">
          ⟨ {activeCfg?.label || "—"} ⟩{gs.toolRound > 0 ? ` ◆ R${gs.toolRound}` : ""}
        </span>
        {elapsedText ? <span className="cosmicElapsed">{elapsedText}</span> : null}
      </div>
      {subtitle && subtitle !== (activeCfg?.label || "") && !P[subtitle] ? (
        <div className="cosmicDetailRow">{subtitle}</div>
      ) : null}
      {hudDetail ? (
        <div className="cosmicDetailRow cosmicDetailHint">{hudDetail}</div>
      ) : null}
    </div>
  );
}
