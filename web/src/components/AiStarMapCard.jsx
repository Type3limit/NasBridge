import React, { useEffect, useRef, useMemo, useState, forwardRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sphere, Trail, Text, Billboard, PointMaterial, Points, Octahedron, Torus } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration, Noise, Vignette, HueSaturation, Glitch } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
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
const NODE_GAP       = 24;
const R_ACTIVE       = 4.60;
const R_DONE         = 1.80;
const R_PEND         = 1.20;
const ORBIT_RX       = 7.0;
const ORBIT_RZ       = 5.8;
const ORBIT_TILT     = -15;
const LIGHT_SPEED    = 0.012;
const WARP_FRAMES    = 160;
const P_DEPART       = 0.20;
const P_CRUISE       = 0.55;
const DEPART_CRUISE  = 2.2;
const DEPART_SPIRAL  = 2.2;
const ARRIVE_SPIRAL  = 2.2;
const CAM_LERP       = 0.050;   // 跟拍响应速度
const PLANET_ROT     = 0.0015;
const CAM_HEIGHT     = 0.8;     // 跟拍相机: 探针正上方高度
const CAM_H_ORBIT    = 2.8;     // 轨道追尾相机相对高度 (大幅推高，形成强烈的俯仰透视)
const CAM_BACK_ORBIT = 1.0;     // 轨道追尾向后外侧拉开距离 (大幅调近，让星球显得极其庞大)
const CAM_HIGH_WIDE  = 7.5;     // 跃迁巡航段相机高度
const CAM_BACK_WIDE  = 6.5;     // 跃迁巡航段向后偏移
const STAR_COUNT     = 2500;

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
  // Increase gap and let size be dynamic
  const gap = NODE_GAP + (rng() - 0.5) * 2.0;

  // Let's generate a pTrait definition array right here and store it implicitly in the props
  return order.map((id, i) => {
    // Generate some randomized trait overrides for the planet to pass back down
    const pTraits = {
      hueShift: (rng() - 0.5) * 40,
      satBoost: (rng() - 0.5) * 20,
      radiusScale: 0.6 + rng() * 0.8, // 0.6 ~ 1.4 radius
      type: Math.floor(rng() * 4), // 行星地貌类型
      rotTiltX: rng() - 0.5,
      rotTiltZ: rng() - 0.5,
      rotSpeed: 0.002 + rng() * 0.006,
      ringProb: rng(),
      roughness: 0.3 + rng() * 0.6,
      metalness: 0.1 + rng() * 0.4
    };
    return {
      id,
      x: i * gap,
      y: Math.sin(i * 1.1 + rng() * 3) * (0.4 + rng() * 1.5),
      z: Math.cos(i * 0.8 + rng() * 3) * (0.2 + rng() * 1.5),
      pTraits
    };
  });
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
  for (let i = 0; i < (o || 6); i++) { v += a * _noise2(x, y); x *= 2.03; y *= 2.03; a *= 0.5; }
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

/* ─── 异步级联生成队列 ───────────────────────────────────────────── */
const _genQueue = [];
let _isGenerating = false;

function _processGenQueue() {
  if (_genQueue.length === 0) {
    _isGenerating = false;
    return;
  }
  _isGenerating = true;
  
  const startTime = performance.now();
  // 每一帧分配 10ms 预算，不卡主线程
  while (_genQueue.length > 0 && performance.now() - startTime < 10) {
    const task = _genQueue[0];
    task.process(8); // 每次处理 8 行，并检查超时
    if (task.done) {
      _genQueue.shift();
      task.resolve(task.tex);
    }
  }

  requestAnimationFrame(_processGenQueue);
}

function generatePlanetTextureAsync(hue, sat, seed, resolution = 512) {
  return new Promise((resolve) => {
    const W = resolution * 2, H = resolution; 
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    const rng = mkRng(seed);
    const seedX = rng() * 500, seedY = rng() * 500;
    const styleRoll = rng();
    const TAU = Math.PI * 2;

    /* ── 每种行星类型的多色板 (H, S%, L%) ──────────────────── */
    const type = styleRoll < 0.25 ? 0 : styleRoll < 0.50 ? 1 : styleRoll < 0.75 ? 2 : 3;
    const palettes = [
      // 0: 高细节气态巨行星 — 暖色高对比带状 (木星/土星/超深蓝气态)
      [
        [hue - 40, Math.min(100, sat + 30), 8],
        [hue - 15, Math.min(100, sat + 15), 18],
        [hue +  5, Math.max(20, sat - 10), 38],
        [hue + 25, Math.min(100, sat + 10), 55],
        [hue + 45, Math.min(100, sat + 30), 32],
        [hue - 20, Math.min(100, sat + 40), 12],
      ],
      // 1: 极恶/深岩/熔岩行星 — 破碎高对比地表
      [
        [hue - 35, Math.min(100, sat + 20),  5],
        [hue - 15, Math.min(100, sat + 10), 12],
        [hue,      Math.min(100, sat + 30), 22],
        [hue + 20, Math.min(100, sat + 45), 45],
        [hue + 40, Math.min(100, sat + 50), 75], // 爆亮的岩浆线
        [hue +  5, Math.min(100, sat + 15), 18],
      ],
      // 2: 剧变/深海/宜居类地行星 — 陆地海洋分离
      [
        [hue - 25, Math.max(20, sat - 20), 10], // 深渊海
        [hue,      sat, 28],                     // 浅海
        [hue + 15, Math.min(100, sat +  5), 35], // 海岸
        [hue + 25, Math.max(10, sat - 30), 60],  // 大片陆地
        [hue -  5, Math.min(100, sat + 20), 45], // 植被/高地
        [hue + 20, Math.max(5,  sat - 40), 95],  // 极地雪冠
      ],
      // 3: 能量晶体/异星 — 高级赛博霓虹
      [
        [hue - 55, Math.min(100, sat + 20),  8],
        [hue - 25, Math.min(100, sat + 35), 20],
        [hue,      Math.min(100, sat + 40), 35],
        [hue + 45, Math.min(100, sat + 45), 58],
        [hue + 75, Math.min(100, sat + 25), 85], // 耀眼能量带
        [hue +105, Math.min(100, sat + 10), 15],
      ],
    ];
    const pal = palettes[type];

    /* ── 散布科幻城市节点亮点 ── */
    const drawCities = rng() > 0.4;
    const hasAtmosphere = rng() > 0.1;
    const cloudSeedX = rng() * 100, cloudSeedY = rng() * 100;

    const imgData = x.createImageData(W, H);
    const dd = imgData.data;

    _genQueue.push({
      py: 0,
      done: false,
      tex: null,
      resolve,
      process(chunkLines) {
        const endY = Math.min(this.py + chunkLines, H);
        for (; this.py < endY; this.py++) {
          for (let px = 0; px < W; px++) {
            const u = px / W, v = this.py / H;
            const theta = u * TAU;
            const phi   = v * Math.PI;
            const sx = Math.sin(phi) * Math.cos(theta);
            const sy = Math.sin(phi) * Math.sin(theta);
            const sz = Math.cos(phi);

            let n;
            let cityAlpha = 0;

          if (type === 0) {
            // 气态巨星
            const warp1 = _fbm(sx * 4 + seedX, sy * 4 + seedY, 5) * 1.5;
            const shX = sx * 8 + warp1;
            const shY = sy * 8 + warp1;
            const band = Math.sin(sz * 15.0 * Math.PI + _fbm(shX, shY, 6) * 4.5) * 0.5 + 0.5;
            const turb = _fbm(sx * 15 + seedX + 99, sy * 15 + sz * 5 + seedY + 77, 6);
            n = Math.pow(band * 0.70 + turb * 0.30, 1.2); 
          } else if (type === 1) {
            // 熔岩
            const ridge0 = 1.0 - Math.abs(_fbm(sx * 3 + seedX, sy * 3 + sz * 2 + seedY, 6) * 2 - 1);
            const ridge1 = 1.0 - Math.abs(_fbm(sx * 12 + seedX + 55, sy * 12 + sz * 8 + seedY + 33, 6) * 2 - 1);
            const base   = Math.pow(_fbm(sx * 4 + seedX + 7, sy * 4 + sz + seedY + 11, 7), 1.5);
            const crack = Math.pow(ridge1, 4.5); 
            n = (base * 0.5 + Math.pow(ridge0, 2) * 0.4) * (1 - crack * 0.5) + crack * 0.8;
            n = Math.max(0, Math.min(1, n * 1.3 - 0.15));
          } else if (type === 2) {
            // 宜居地球
            const base = _fbm(sx * 3 + seedX, sy * 3 + sz + seedY, 8); 
            let land = base > 0.48 ? 0.5 + Math.pow(base - 0.48, 0.8) * 1.5 : base * 0.8; 
            const polar  = Math.pow(Math.abs(sz), 3.0);
            n = Math.max(land, polar * 1.1) * 0.85 + _fbm(sx * 20 + seedX + 88, sy * 20 + sz * 15 + seedY + 44, 4) * 0.15;
          } else {
            // 能量星球
            const ang  = Math.atan2(sy, sx);
            const dist = Math.acos(Math.max(-1, Math.min(1, sz)));
            const warp = _fbm(Math.cos(ang) * 4 + seedX, Math.sin(ang) * 4 + seedY, 5) * 3.5;
            n = _fbm(
              Math.cos(ang * 2 + dist * 8 + warp) * 3.5 + seedX,
              Math.sin(ang * 2 + dist * 8 + warp) * 3.5 + seedY, 7
            );
            n = Math.pow(n, 1.4) * 1.2;
          }

          if (drawCities && n > 0.45 && n < 0.65 && type !== 0) {
            const cityNoise = Math.pow(_fbm(sx * 60 + seedX, sy * 60 + seedY, 4), 5.5);
            if (cityNoise > 0.3) {
              cityAlpha = (cityNoise - 0.3) * 4.0;
            }
          }

          n = Math.max(0, Math.min(1, n));

          const palPos = n * (pal.length - 1);
          const palI   = Math.min(Math.floor(palPos), pal.length - 2);
          let palF     = palPos - palI;
          palF = palF * palF * (3 - 2 * palF);
          
          const c0 = pal[palI], c1 = pal[palI + 1];
          const lH = c0[0] + (c1[0] - c0[0]) * palF;
          const lS = c0[1] + (c1[1] - c0[1]) * palF;
          let lL = c0[2] + (c1[2] - c0[2]) * palF;

          if (cityAlpha > 0) {
            lL = Math.max(lL, 50) + cityAlpha * 60; 
          }

          let [r, g, b] = hslArr(lH, lS, Math.min(100, lL));

          if (hasAtmosphere && type !== 0 && type !== 1) { 
             const cloudFbm = _fbm(sx * 5 + cloudSeedX, sy * 5 + sz * 2.5 + cloudSeedY, 7);
             const cloudSwirl = _fbm(sx * 10 - cloudSeedY, sy * 10 + cloudSeedX, 5);
             const cloudVal = Math.pow(cloudFbm * 0.6 + cloudSwirl * 0.4, 2.0);
             if (cloudVal > 0.15) {
                const cAlpha = Math.min(1, (cloudVal - 0.15) * 4.5);
                const cloudLight = (cloudVal > 0.3) ? 255 : 200 + (cloudVal - 0.15) * 360;
                r = r * (1 - cAlpha) + cloudLight * cAlpha;
                g = g * (1 - cAlpha) + cloudLight * cAlpha;
                b = b * (1 - cAlpha) + cloudLight * cAlpha;
             }
          }

          const idx = (this.py * W + px) * 4;
          dd[idx] = r; dd[idx + 1] = g; dd[idx + 2] = b; dd[idx + 3] = 255;
        }
      }

      if (this.py >= H) {
        x.putImageData(imgData, 0, 0);

        /* ── 随机环境环（星环）或者极光 ── */
        const addRing = rng() > 0.6;
        if (addRing) {
          const ringW = 4 + rng() * 6; // 更锐利的极光带
          const ringY = H * (0.3 + rng() * 0.4);
          const rg = x.createLinearGradient(0, ringY - ringW, 0, ringY + ringW);
          rg.addColorStop(0, "hsla(0,0%,0%,0)");
          rg.addColorStop(0.3, `hsla(${hue + 45}, ${sat}%, 70%, ${0.1 + rng() * 0.2})`);
          rg.addColorStop(0.5, `hsla(${hue + 45}, ${sat}%, 95%, ${0.4 + rng() * 0.5})`);
          rg.addColorStop(0.7, `hsla(${hue + 45}, ${sat}%, 70%, ${0.1 + rng() * 0.2})`);
          rg.addColorStop(1, "hsla(0,0%,0%,0)");
          x.fillStyle = rg;
          x.fillRect(0, 0, W, H);
        }

        /* ── 侧向恒星照明/大气散射层 ───────────────────────────────── */
        const shine = x.createRadialGradient(W * 0.7, H * 0.3, 0, W * 0.5, H * 0.5, W * 0.4);
        shine.addColorStop(0,    `hsla(${hue + 15}, ${sat}%, 90%, 0.15)`); // 科幻侧逆光
        shine.addColorStop(0.4,  `hsla(${hue}, ${sat}%, 60%, 0.05)`);
        shine.addColorStop(0.6,  "hsla(0,0%,0%,0)");
        shine.addColorStop(1,    `hsla(240, 50%, 10%, 0.4)`); // 暗部冷调星际阴影
        x.fillStyle = shine; x.fillRect(0, 0, W, H);

        /* ── 极地大气光晕 ─────────────────────────────────────────── */
        const pg = x.createLinearGradient(0, 0, 0, H);
        pg.addColorStop(0,    `hsla(${hue + 35}, ${Math.min(100, sat + 12)}%, 80%, 0.38)`);
        pg.addColorStop(0.18, "hsla(0,0%,0%,0)");
        pg.addColorStop(0.82, "hsla(0,0%,0%,0)");
        pg.addColorStop(1,    `hsla(${hue - 18}, ${Math.min(100, sat + 10)}%, 62%, 0.30)`);
        x.fillStyle = pg; x.fillRect(0, 0, W, H);

        /* ── 地表特征: 风暴/冰盖/火山口 ──────────────────────────── */
        const feats = 2 + Math.floor(rng() * 6);
        for (let i = 0; i < feats; i++) {
          const fx  = rng() * W;
          const fy  = H * 0.15 + rng() * H * 0.70;
          const fr  = (8 + rng() * 60) * (W / 1024); // 尺寸调整
          const fhs = (rng() - 0.5) * 80;
          const fls = 15 + rng() * 50;
          const alpha = 0.5 + rng() * 0.4;
          const fg  = x.createRadialGradient(fx, fy, 0, fx, fy, fr);
          fg.addColorStop(0,    `hsla(${hue + fhs}, ${Math.min(100, sat + 30)}%, ${fls}%, ${alpha})`);
          fg.addColorStop(0.45, `hsla(${hue + fhs * 0.5}, ${sat}%, ${fls * 0.55}%, ${alpha * 0.3})`);
          fg.addColorStop(1,    "hsla(0,0%,0%,0)");
          x.fillStyle = fg;
          x.beginPath();
          x.ellipse(fx, fy, fr * (0.4 + rng() * 0.8), fr * (0.2 + rng() * 0.6), rng() * Math.PI, 0, TAU);
          x.fill();
        }

        const tex = new THREE.CanvasTexture(c);
        tex.anisotropy = 16;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        this.tex = tex;
        this.done = true;
      }
    }});

    if (!_isGenerating) {
      _processGenQueue();
    }
  });
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
   零重力数据碎片 (Floating Digital Dust)
   ═══════════════════════════════════════════════════════════════════ */
function DigitalDust({ seed }) {
  const groupRef = useRef();
  const dusts = useMemo(() => {
    const rng = mkRng(seed ^ 0xC0DE);
    const words = ["0x4F", "0x8A", "SYS", "ACT", "0x00", "NULL", "WARN", "SYNC"];
    return Array.from({ length: 40 }).map(() => ({
      text: words[Math.floor(rng() * words.length)],
      pos: [(rng() - 0.5) * 50, (rng() - 0.5) * 30, (rng() - 0.5) * 50],
      speed: 0.005 + rng() * 0.015,
      opacity: 0.1 + rng() * 0.3
    }));
  }, [seed]);

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.children.forEach((c, i) => {
        c.position.y += dusts[i].speed;
        if (c.position.y > 15) c.position.y = -15; // 循环飘动
      });
    }
  });

  return (
    <group ref={groupRef}>
      {dusts.map((d, i) => (
        <Billboard key={i} position={d.pos}>
          <Text fontSize={0.2} color="#77aaff" fillOpacity={d.opacity} depthWrite={false} font={undefined}>
            {d.text}
          </Text>
        </Billboard>
      ))}
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   曲率引擎拖尾 (Warp Trail Effect)
   ═══════════════════════════════════════════════════════════════════ */
function WarpEffect() {
  const { camera } = useThree();
  const meshRef = useRef();
  const prevCamPos = useRef(new THREE.Vector3());
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  const count = 400;
  const particles = useMemo(() => {
    return Array.from({ length: count }).map(() => ({
      pos: new THREE.Vector3((Math.random() - 0.5) * 80, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 80),
      speed: Math.random()
    }));
  }, []);

  useEffect(() => {
    prevCamPos.current.copy(camera.position);
  }, [camera]);

  useFrame(() => {
    if (!meshRef.current) return;
    
    const vel = new THREE.Vector3().subVectors(camera.position, prevCamPos.current);
    prevCamPos.current.copy(camera.position);
    
    const speed = vel.length();
    // 提高阈值，确保仅在飞船星际跃迁（脱离轨道或巡航阶段的高速移动）时才显示，环绕时的慢速不显示
    const isWarping = speed > 0.15; 
    
    // 加速时的夸张拉长
    const length = isWarping ? speed * 60.0 : 0.01;
    
    if (speed > 0.0001) vel.normalize();
    else vel.set(0, 0, 1);
    
    particles.forEach((p, i) => {
      // 粒子向后运动
      dummy.position.copy(p.pos);
      if (isWarping) {
        dummy.position.addScaledVector(vel, -p.speed * 0.8);
        p.pos.copy(dummy.position);
        
        // 如果跑到屏幕很后面就把它挪回到前方
        const camDist = dummy.position.distanceTo(camera.position);
        if (camDist > 40) {
          dummy.position.copy(camera.position).addScaledVector(vel, 30 + Math.random() * 20);
          dummy.position.x += (Math.random() - 0.5) * 40;
          dummy.position.y += (Math.random() - 0.5) * 40;
          dummy.position.z += (Math.random() - 0.5) * 40;
          p.pos.copy(dummy.position);
        }
      }

      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), vel);
      dummy.scale.set(1, 1, length * (0.5 + p.speed * 0.5));
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    });
    
    meshRef.current.instanceMatrix.needsUpdate = true;
    // 当速度超过阈值时才平滑显示出来
    meshRef.current.material.opacity = isWarping ? Math.min(0.8, (speed - 0.15) * 5) : 0;
  });

  return (
    <instancedMesh ref={meshRef} args={[null, null, count]}>
      <boxGeometry args={[0.02, 0.02, 1]} />
      <meshBasicMaterial color="#a0d8ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   活动节点的锁定 HUD (Targeting HUD)
   ═══════════════════════════════════════════════════════════════════ */
function TargetingHUD({ radius, color }) {
  const groupRef = useRef();

  useFrame(() => {
    if (groupRef.current) {
      const t = Date.now() * 0.001;
      // 保持平滑但复杂的多轴自旋，去掉突兀的上下位移
      groupRef.current.rotation.y = t * 0.4;
      groupRef.current.rotation.x = t * 0.6;
      groupRef.current.rotation.z = t * 0.3;
    }
  });

  return (
    <group scale={[radius * 1.4, radius * 1.4, radius * 1.4]}>
      <group ref={groupRef}>
        {/* 外层断续刻度环 */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1, 0.008, 4, 64, Math.PI * 1.6]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
        {/* 内层十字交叉准星轨道 */}
        <mesh rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.92, 0.004, 4, 64, Math.PI * 2]} />
          <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.92, 0.004, 4, 64, Math.PI * 2]} />
          <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
        </mesh>
      </group>

      {/* 固定不动的极客地平线与外围瞄准角 */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.11, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.105, 0.015, 3, 4, Math.PI * 0.1]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GPU 动态生成材质: 星球 Shader
   ═══════════════════════════════════════════════════════════════════ */
const PlanetMaterial = React.forwardRef(({ hue, sat, seed, pType, status, ...props }, ref) => {
  const matRef = useRef();

  const uniforms = useMemo(() => {
    // Generate palettes dynamically
    const type = pType % 4;
    const hr = hue;
    const sr = sat;
    const palettes = [
      [
        [hr - 40, Math.min(100, sr + 30), 8],
        [hr - 15, Math.min(100, sr + 15), 18],
        [hr +  5, Math.max(20, sr - 10), 38],
        [hr + 25, Math.min(100, sr + 10), 55],
        [hr + 45, Math.min(100, sr + 30), 32],
        [hr - 20, Math.min(100, sr + 40), 12],
      ],
      [
        [hr - 35, Math.min(100, sr + 20),  5],
        [hr - 15, Math.min(100, sr + 10), 12],
        [hr,      Math.min(100, sr + 30), 22],
        [hr + 20, Math.min(100, sr + 45), 45],
        [hr + 40, Math.min(100, sr + 50), 75],
        [hr +  5, Math.min(100, sr + 15), 18],
      ],
      [
        [hr - 25, Math.max(20, sr - 20), 10],
        [hr,      sr, 28],
        [hr + 15, Math.min(100, sr +  5), 35],
        [hr + 25, Math.max(10, sr - 30), 60],
        [hr -  5, Math.min(100, sr + 20), 45],
        [hr + 20, Math.max(5,  sr - 40), 95],
      ],
      [
        [hr - 55, Math.min(100, sr + 20),  8],
        [hr - 25, Math.min(100, sr + 35), 20],
        [hr,      Math.min(100, sr + 40), 35],
        [hr + 45, Math.min(100, sr + 45), 58],
        [hr + 75, Math.min(100, sr + 25), 85],
        [hr +105, Math.min(100, sr + 10), 15],
      ],
    ];
    let palArr = palettes[type].map(c => hslToRGB(c[0], c[1], c[2]));
    
    return {
      uTime: { value: 0 },
      uSeed: { value: seed },
      uType: { value: type },
      uPal: { value: palArr },
      uMode: { value: status === 'active' ? 2.0 : status === 'done' ? 1.0 : 0.0 }
    };
  }, [hue, sat, seed, pType, status]);

  useFrame((state) => {
    if (matRef.current && matRef.current.userData.shader) {
      const u = matRef.current.userData.shader.uniforms;
      u.uTime.value = state.clock.elapsedTime;
      u.uMode.value = uniforms.uMode.value;
      u.uSeed.value = uniforms.uSeed.value;
      u.uType.value = uniforms.uType.value;
      u.uPal.value  = uniforms.uPal.value;
    }
  });

  const onBeforeCompile = React.useCallback((shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uSeed = { value: 0 };
    shader.uniforms.uType = { value: 0 };
    shader.uniforms.uPal = { value: [] };
    shader.uniforms.uMode = { value: 0 };
    matRef.current.userData.shader = shader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vPosLocal;`
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vPosLocal = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vPosLocal;
       uniform float uTime;
       uniform float uSeed;
       uniform int uType;
       uniform float uMode; // 0=pending, 1=done, 2=active
       uniform vec3 uPal[6];
       
       float sharedRoughness = 0.8;
       float sharedMetalness = 0.1;
       
       vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
       vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
       float snoise(vec3 v){ 
         const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
         const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
         vec3 i  = floor(v + dot(v, C.yyy) );
         vec3 x0 =   v - i + dot(i, C.xxx) ;
         vec3 g = step(x0.yzx, x0.xyz);
         vec3 l = 1.0 - g;
         vec3 i1 = min( g.xyz, l.zxy );
         vec3 i2 = max( g.xyz, l.zxy );
         vec3 x1 = x0 - i1 + 1.0 * C.xxx;
         vec3 x2 = x0 - i2 + 2.0 * C.xxx;
         vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
         i = mod(i, 289.0 ); 
         vec4 p = permute( permute( permute( 
                    i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
                  + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
                  + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
         float n_ = 1.0/7.0;
         vec3  ns = n_ * D.wyz - D.xzx;
         vec4 j = p - 49.0 * floor(p * ns.z *ns.z); 
         vec4 x_ = floor(j * ns.z);
         vec4 y_ = floor(j - 7.0 * x_ );
         vec4 x = x_ *ns.x + ns.yyyy;
         vec4 y = y_ *ns.x + ns.yyyy;
         vec4 h = 1.0 - abs(x) - abs(y);
         vec4 b0 = vec4( x.xy, y.xy );
         vec4 b1 = vec4( x.zw, y.zw );
         vec4 s0 = floor(b0)*2.0 + 1.0;
         vec4 s1 = floor(b1)*2.0 + 1.0;
         vec4 sh = -step(h, vec4(0.0));
         vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
         vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
         vec3 p0 = vec3(a0.xy,h.x);
         vec3 p1 = vec3(a0.zw,h.y);
         vec3 p2 = vec3(a1.xy,h.z);
         vec3 p3 = vec3(a1.zw,h.w);
         vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
         p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
         vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
         m = m * m;
         return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
       }
       float fbm(vec3 x) {
           float v = 0.0; float a = 0.5; vec3 shift = vec3(100.0);
           for (int i = 0; i < 7; ++i) { v += a * snoise(x); x = x * 2.0 + shift; a *= 0.5; }
           return v;
       }
       vec3 getPalColor(float n, vec3 p[6]) {
         float idx = clamp(n, 0.0, 1.0) * 5.0;
         int i = int(floor(idx));
         float f = smoothstep(0.0, 1.0, fract(idx));
         if(i <= 0) return mix(p[0], p[1], f);
         if(i == 1) return mix(p[1], p[2], f);
         if(i == 2) return mix(p[2], p[3], f);
         if(i == 3) return mix(p[3], p[4], f);
         return mix(p[4], p[5], f);
       }
       `
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       vec3 pos = normalize(vPosLocal);
       float t = uTime * 0.05;
       vec3 offset = vec3(uSeed * 13.3, uSeed * 27.7, uSeed * 31.1);
       float n = 0.0;
       float emMask = 0.0;
       
       if (uType == 0) {
         // Gas Giant (Large swirls and bands)
         vec3 warp = pos * 1.5 + offset;
         vec3 q = vec3(fbm(warp + vec3(0.0, t, 0.0)), fbm(warp + vec3(5.2)), fbm(warp + vec3(1.3)));
         vec3 r = vec3(fbm(warp * 2.0 + 4.0 * q + vec3(t*2.0, -t, 0.0)), fbm(warp * 2.0 + 4.0 * q + vec3(8.3)), 0.0);
         
         float lat = pos.y * 5.0 + r.x * 2.5;
         float banding = sin(lat) * 0.5 + 0.5;
         
         n = mix(banding, fbm(warp * 1.5 + r * 3.0) * 0.5 + 0.5, 0.5);
         n = smoothstep(0.1, 0.9, n);
         
         emMask = 0.0;
         sharedRoughness = 0.4;
         sharedMetalness = 0.1;
       } else if (uType == 1) {
         // Lava Planet (Big darker plates, sharply glowing cracks)
         float warp = fbm(pos * 1.5 + offset) * 0.5 + 0.5;
         float rawCrack = fbm(pos * 2.5 + offset + warp * 1.5);
         float cracks = 1.0 - abs(rawCrack); // Ridge 
         cracks = pow(cracks, 8.0); // very sharp and thin
         
         float base = fbm(pos * 2.0 + offset) * 0.5 + 0.5;
         
         n = mix(base * 0.4, 1.0, cracks);
         emMask = cracks * 3.0; 
         
         sharedRoughness = mix(0.85, 0.1, cracks);
         sharedMetalness = mix(0.1, 0.8, cracks);
       } else if (uType == 2) {
         // Earth-like (Large distinct oceans and continents, separate rolling clouds)
         float warp = fbm(pos * 1.0 + offset) * 0.5 + 0.5;
         float base = fbm(pos * 1.5 + warp * 0.8 + offset) * 0.5 + 0.5;
         
         float landMask = smoothstep(0.48, 0.52, base); 
         
         float landDetail = (fbm(pos * 6.0 + offset) * 0.5 + 0.5) * 0.2;
         float landColor = 0.5 + landDetail + base * 0.2; 
         
         float oceanColor = base * 0.4;
         
         n = mix(oceanColor, landColor, landMask);
         
         // Atmosphere/Clouds over it
         float cloudWarp = fbm(pos * 1.5 - vec3(t*0.5, 0.0, t*0.2));
         float clouds = fbm(pos * 2.5 + cloudWarp * 1.5 + vec3(t, 0.0, 0.0)) * 0.5 + 0.5;
         float cloudMask = smoothstep(0.55, 0.75, clouds);
         
         // Night side city lights
         float cityPop = fbm(pos * 20.0 + offset) * 0.5 + 0.5;
         emMask = landMask * smoothstep(0.65, 0.8, cityPop) * (1.0 - cloudMask) * 2.0;
         
         n = mix(n, 0.9 + clouds*0.1, cloudMask * 0.8);

         sharedRoughness = mix(0.1, 0.9, landMask);
         sharedMetalness = mix(0.7, 0.0, landMask);
       } else {
         // Sci-Fi / Cyber (Geometric patterns and holograms)
         float warp = fbm(pos * 1.5 + offset - vec3(t*0.5));
         float base = fbm(pos * 2.0 + warp * 1.5) * 0.5 + 0.5;
         
         n = smoothstep(0.2, 0.8, base);
         
         vec3 g = abs(fract(pos * 8.0 + vec3(t*1.5)) - 0.5);
         float grid = 1.0 - smoothstep(0.0, 0.05, min(min(g.x, g.y), g.z));
         
         float pulse = sin(pos.y * 15.0 - t * 8.0) * 0.5 + 0.5;
         
         emMask = grid * pulse * 2.0;
         n = mix(n, 1.0, grid * pulse * 0.5);
         
         sharedRoughness = 0.3;
         sharedMetalness = 0.6;
       }
       
       n = clamp(n, 0.0, 1.0);
       vec3 finalColor = getPalColor(n, uPal);
       
       if (uMode < 0.5) {
         finalColor *= 0.15; // deep dark pending
         emMask *= 0.05;
       }
       
       diffuseColor = vec4(finalColor, 1.0);
      `
    ).replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       roughnessFactor = sharedRoughness;
      `
    ).replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
       metalnessFactor = sharedMetalness;
      `
    ).replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       vec3 glowColor = uPal[4]; // bright color
       if (uType == 2) glowColor = vec3(1.0, 0.8, 0.4); 
       
       float totalEm = emMask * (uMode > 1.5 ? 1.5 : 0.5);
       if (uMode < 0.5) totalEm *= 0.1;
       
       // Override emissive component entirely for our custom glow plus rim lighting
       float rim = 1.0 - max(0.0, dot(vNormal, vec3(0.0, 0.0, 1.0)));
       float rimVal = smoothstep(0.6, 1.0, rim) * (uMode > 1.5 ? 0.3 : 0.1);
       
       totalEmissiveRadiance = emissive + glowColor * totalEm + uPal[3] * rimVal;
      `
    );
  }, []);

  return (
    <meshStandardMaterial
      ref={(r) => {
        matRef.current = r;
        if (typeof ref === 'function') ref(r);
        else if (ref) ref.current = r;
      }}
      onBeforeCompile={onBeforeCompile}
      {...props}
    />
  );
});

/* ═══════════════════════════════════════════════════════════════════
   行星球体
   ═══════════════════════════════════════════════════════════════════ */
function Planet({ id, position, status, pTraits }) {
  const meshRef      = useRef();
  const rimRef       = useRef();
  const coronaRef    = useRef();
  const coronaMatRef = useRef();
  const novaRingRef  = useRef();
  const novaRingMatRef = useRef();
  const cfg = P[id];
  if (!cfg) return null;

  const pt  = pTraits || {};
  const hue = cfg.hue + (pt.hueShift || 0);
  const sat = Math.max(35, Math.min(100, cfg.sat + (pt.satBoost || 0)));
  const r   = nodeRadius(status) * (pt.radiusScale || 1.0);

  // 稳定生成固定的随机种子
  const seedGen = useMemo(() => {
    let s = 0; 
    for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) | 0;
    return s ^ (pt.texSeed || 0);
  }, [id, pt.texSeed]);

  /* 辉光 Sprite 纹理 — 以行星自身色调生成径向扩散光 */
  const glowTex = useMemo(() => generateGlowTex(hue, sat), [hue, sat]);

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
    /* 激活态: 光晕脉动及新星爆发环 */
    if (status === "active") {
      const t = Date.now() * 0.0012;
      const pulse = 1 + Math.sin(t) * 0.13 + Math.sin(t * 2.7) * 0.06;
      if (coronaRef.current) coronaRef.current.scale.setScalar(pulse);
      if (coronaMatRef.current) {
        coronaMatRef.current.opacity = 0.78 + Math.sin(t * 1.4) * 0.12;
      }
      if (novaRingRef.current) {
        const loop = (t * 0.5) % 1.0;
        novaRingRef.current.scale.setScalar(1 + loop * 8.0);
        novaRingMatRef.current.opacity = Math.max(0, 1.0 - loop * loop * 1.5) * 0.4;
      }
    }
  });

  const coronaSize    = status === "active" ? r * 5.5 : status === "done" ? r * 3.2 : r * 1.8;
  const coronaOpacity = status === "active" ? 0.78 : status === "done" ? 0.40 : 0.08;

  return (
    <group position={position}>
      {/* 辉光 corona */}
      <sprite ref={coronaRef} scale={[coronaSize, coronaSize, 1]}>
        <spriteMaterial ref={coronaMatRef} map={glowTex} transparent
          opacity={coronaOpacity}
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </sprite>
      
      {/* 星球本体 */}
      <Sphere ref={meshRef} args={[r, 128, 128]}>
        <PlanetMaterial 
          hue={hue} 
          sat={sat} 
          seed={seedGen} 
          pType={pt.type ?? 0} 
          status={status}
          roughness={status === "active" ? 0.7 : (pt.roughness ?? 0.85)}
          metalness={0.1}
          transparent={status === "pending"}
          opacity={status === "pending" ? 0.40 : 1.0}
        />
      </Sphere>
      
      {/* 稀薄的大气散射边晕 */}
      {status !== "pending" && (
        <Sphere args={[r * 1.05, 64, 64]}>
          <meshBasicMaterial 
            color={rimColor} 
            transparent 
            opacity={status === "active" ? 0.25 : 0.12} 
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.BackSide}
          />
        </Sphere>
      )}

      {/* 新星量子能量爆流 (当处于活跃状态时) */}
      {status === "active" && (
        <mesh ref={novaRingRef} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r * 1.1, r * 1.25, 64]} />
          <meshBasicMaterial ref={novaRingMatRef} color="#ccffff" transparent opacity={0.8} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}

      {/* 当状态活跃时展示锁定HUD */}
      {status === "active" && <TargetingHUD radius={r} color={rimColor} />}

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
   航线弧与数据光流动流
   ═══════════════════════════════════════════════════════════════════ */
function RouteArc({ from, to, lit, arcHeight = 0.6 }) {
  const { geo, glowGeo, curve } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += arcHeight;
    const c = new THREE.QuadraticBezierCurve3(a, mid, b);
    return {
      geo: new THREE.TubeGeometry(c, 48, lit ? 0.028 : 0.015, 6, false),
      glowGeo: new THREE.TubeGeometry(c, 48, lit ? 0.12 : 0.06, 6, false),
      curve: c
    };
  }, [from, to, lit, arcHeight]);

  const packetRef = useRef();
  
  useFrame(() => {
    if (lit && packetRef.current) {
      // 光量子流沿从 from 到 to 的曲线运动
      const t = (Date.now() * 0.001) % 1; // 1秒跑完一趟
      const pos = curve.getPointAt(t);
      packetRef.current.position.copy(pos);
      // 动态闪烁与大小
      packetRef.current.scale.setScalar(1 + Math.sin(t * Math.PI * 10) * 0.4);
    }
  });

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
      {/* 传输数据流光子光点 */}
      {lit && (
        <group ref={packetRef}>
          <Sphere args={[0.08, 8, 8]}>
            <meshBasicMaterial color="#ffffff" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
          </Sphere>
          <Sphere args={[0.18, 8, 8]}>
            <meshBasicMaterial color="#66bbff" transparent opacity={0.4} blending={THREE.AdditiveBlending} depthWrite={false} />
          </Sphere>
        </group>
      )}
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
   远景恒星 (Distant Sun / Red Giant)
   ═══════════════════════════════════════════════════════════════════ */
function DistantSun({ seed }) {
  const { pos, hue, sat, scale } = useMemo(() => {
    const rng = mkRng(seed ^ 0x51A);
    const angle = rng() * Math.PI * 2;
    // 放在场景边缘非常遥远的地方
    const dist = 50 + rng() * 30;
    
    // 可能是炽热蓝矮星，黄矮星(太阳)，或者是红巨星
    const isRed = rng() > 0.5;
    const h = isRed ? 5 + rng() * 25 : 200 + rng() * 30; // 5-30:红橙, 200-230:蓝白
    return {
      pos: [Math.cos(angle) * dist, (rng() - 0.5) * 20, Math.sin(angle) * dist],
      hue: h,
      sat: 80 + rng() * 20,
      scale: 15 + rng() * 15,
    };
  }, [seed]);

  const color = new THREE.Color().setHSL(hue / 360, sat / 100, 0.7);
  const glowCol = new THREE.Color().setHSL(hue / 360, sat / 100, 0.5);

  return (
    <group position={pos}>
      <Sphere args={[1, 32, 32]} scale={scale}>
        <meshBasicMaterial color={color} toneMapped={false} />
      </Sphere>
      <sprite scale={[scale * 4.5, scale * 4.5, 1]}>
        <spriteMaterial 
          map={generateGlowTex(hue, sat)} 
          color={glowCol} 
          transparent 
          opacity={0.85} 
          blending={THREE.AdditiveBlending} 
          depthWrite={false} 
        />
      </sprite>
      <pointLight color={color} intensity={2.5} distance={150} decay={1.5} />
    </group>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   小行星带 (Asteroid Belt)
   ═══════════════════════════════════════════════════════════════════ */
function AsteroidBelt({ seed }) {
  const count = 600;
  const meshRef = useRef();
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const meta = useMemo(() => {
    const rng = mkRng(seed ^ 0xA57);
    const data = [];
    for (let i = 0; i < count; i++) {
      // 环形分布
      const angle = rng() * Math.PI * 2;
      const radius = 25 + (rng() - 0.5) * 8 + (rng() - 0.5) * 4; // 主环半径 25，带宽度 12左右
      const height = (rng() - 0.5) * 4 * Math.max(0, 1 - Math.abs(radius - 25)/6); // 中间厚边缘薄
      
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      
      data.push({
        x, y: height, z,
        rotX: rng() * Math.PI * 2,
        rotY: rng() * Math.PI * 2,
        rotZ: rng() * Math.PI * 2,
        sc: 0.1 + rng() * 0.4 + (rng()>0.9 ? rng()*0.5 : 0), // 偶尔有个大石头
        speed: 0.005 + rng() * 0.015,
        dist: radius,
        angle: angle
      });
    }
    return data;
  }, [seed]);

  useFrame(() => {
    if (!meshRef.current) return;
    const time = Date.now() * 0.0002;
    meta.forEach((m, i) => {
      // 小行星带绕着场景中心缓慢公转
      const a = m.angle + time * m.speed;
      dummy.position.set(Math.cos(a) * m.dist, m.y, Math.sin(a) * m.dist);
      // 自转
      dummy.rotation.set(m.rotX + time, m.rotY + time * 1.2, m.rotZ + time * 0.8);
      dummy.scale.set(m.sc, m.sc, m.sc);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[null, null, count]}>
      {/* 简单多面体模拟不规则陨石 */}
      <dodecahedronGeometry args={[1, 0]} />
      <meshStandardMaterial 
        color="#58626e"
        roughness={0.9} 
        metalness={0.1}
        flatShading={false}
      />
    </instancedMesh>
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
    camUpX: 0, camUpY: 1, camUpZ: 0,
    camTargetUpX: 0, camTargetUpY: 1, camTargetUpZ: 0,
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
      
      const awayX = p.x - ax;
      const awayZ = p.z - az;
      const len = Math.sqrt(awayX * awayX + awayZ * awayZ) || 1;
      s.camUpX = awayX / len; s.camUpY = 0.4; s.camUpZ = awayZ / len;
      s.camTargetUpX = s.camUpX; s.camTargetUpY = 0.4; s.camTargetUpZ = s.camUpZ;
      
      s._inited = true;
      prevActiveId.current = activeId;
      camera.position.set(s.camX, s.camY, s.camZ);
      camera.up.set(s.camUpX, s.camUpY, s.camUpZ).normalize();
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

      /* 追尾越肩相机 (Trailing Camera): 完全跟随飞船轨迹 */
      const pBehind = orbitPos(s.angle - 0.10, s.orbitCx, s.orbitCy, s.orbitCz);
      
      const bAwayX = pBehind.x - s.orbitCx;
      const bAwayZ = pBehind.z - s.orbitCz;
      const bLen = Math.sqrt(bAwayX * bAwayX + bAwayZ * bAwayZ) || 1;
      
      // 相机退后并微微靠外，稍抬高
      s.camTargetX = pBehind.x + (bAwayX / bLen) * 0.6;
      s.camTargetY = pBehind.y + 0.8;
      s.camTargetZ = pBehind.z + (bAwayZ / bLen) * 0.6;

      // 视线焦点：紧盯飞船正前方，保证飞船不仅在视野内，还在偏下方
      const pAhead = orbitPos(s.angle + 0.20, s.orbitCx, s.orbitCy, s.orbitCz);
      s.lookTargetX = pAhead.x;
      s.lookTargetY = pAhead.y + 0.4;
      s.lookTargetZ = pAhead.z;

      // 视场翻滚 (Banking Roll)：在星球轨道上，令相机的上方 (Up) 指向背离星球的方向。
      // 如此即可将整个星球从“占据在左边或右边”直接旋转90度，使其彻底横陈在你的“脚下”(即屏幕下方)！
      s.camTargetUpX = bAwayX / bLen;
      s.camTargetUpY = 0.4; // 混入少量 Y，避免完全侧躺
      s.camTargetUpZ = bAwayZ / bLen;


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
        const height = CAM_H_ORBIT + (CAM_HIGH_WIDE - CAM_H_ORBIT) * e;
        const back   = CAM_BACK_ORBIT + (CAM_BACK_WIDE - CAM_BACK_ORBIT) * e;
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

        // 起飞时，相机从侧身侧滚逐渐恢复为水平 (up = Y)
        s.camTargetUpX = naxx * (1 - e); // 从背离星球
        s.camTargetUpY = 0.4 * (1 - e) + 1.0 * e; // 恢复到 1.0
        s.camTargetUpZ = nazz * (1 - e);

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
        s.camTargetUpX = 0;
        s.camTargetUpY = 1;
        s.camTargetUpZ = 0;

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
        const height = CAM_HIGH_WIDE + (CAM_H_ORBIT - CAM_HIGH_WIDE) * e;
        const back   = CAM_BACK_WIDE + (CAM_BACK_ORBIT - CAM_BACK_WIDE) * e;
        s.camTargetX = s.dotX + (bkx / bkLen) * back;
        s.camTargetY = s.dotY + height;
        s.camTargetZ = s.dotZ + (bkz / bkLen) * back;
        s.lookTargetX = s.toX;
        s.lookTargetY = s.toY;
        s.lookTargetZ = s.toZ;

        // 到达时，相机逐渐从水平变为沿星球轨道倾斜
        s.camTargetUpX = nax2 * e;  // 逐渐变为背离目标星球 (away)
        s.camTargetUpY = 1.0 * (1 - e) + 0.4 * e; // Y 分量逐渐减弱
        s.camTargetUpZ = naz2 * e;
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
    
    // Up 向量平滑
    const upLerp = CAM_LERP * 0.4; // Up 向量平滑可以慢一点，更柔和
    s.camUpX += (s.camTargetUpX - s.camUpX) * upLerp;
    s.camUpY += (s.camTargetUpY - s.camUpY) * upLerp;
    s.camUpZ += (s.camTargetUpZ - s.camUpZ) * upLerp;

    camera.position.set(s.camX, s.camY, s.camZ);
    camera.up.set(s.camUpX, s.camUpY, s.camUpZ).normalize();
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

  /* 闪烁（帧级）与动画 */
  const flickerRef = useRef(null);
  const glowRef2 = useRef(null);
  const frameRef = useRef(null);
  const ringRef1 = useRef(null);
  const ringRef2 = useRef(null);

  useFrame(() => {
    const t = Date.now() * 0.006;
    const flicker = 0.7 + Math.sin(t * 7.3) * 0.15 + Math.sin(t * 13.1) * 0.1 + Math.random() * 0.05;
    if (flickerRef.current) flickerRef.current.opacity = flicker;
    if (glowRef2.current) glowRef2.current.opacity = flicker * 0.25;

    if (frameRef.current) {
      frameRef.current.rotation.x += 0.02;
      frameRef.current.rotation.y += 0.03;
    }
    if (ringRef1.current) {
      ringRef1.current.rotation.x += 0.05;
      ringRef1.current.rotation.y += 0.02;
    }
    if (ringRef2.current) {
      ringRef2.current.rotation.x -= 0.04;
      ringRef2.current.rotation.z -= 0.03;
    }
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
        <group>
          {/* 内核发光点 */}
          <Sphere args={[0.022, 12, 8]}>
            <meshBasicMaterial ref={flickerRef} color="#ffffff" transparent toneMapped={false} />
          </Sphere>
          {/* 科技感八面体骨架 */}
          <Octahedron ref={frameRef} args={[0.048, 0]}>
            <meshBasicMaterial color={dotColor} wireframe transparent opacity={0.8} />
          </Octahedron>
          {/* 动态轨道环 1 */}
          <Torus ref={ringRef1} args={[0.065, 0.002, 4, 24]}>
            <meshBasicMaterial color="#ffffff" transparent opacity={0.6} toneMapped={false} />
          </Torus>
          {/* 动态轨道环 2 */}
          <Torus ref={ringRef2} args={[0.085, 0.002, 4, 24]}>
            <meshBasicMaterial color={dotColor} transparent opacity={0.4} toneMapped={false} />
          </Torus>
        </group>
      </Trail>
      {/* 小辉光 */}
      <Sphere args={[0.12, 8, 6]}>
        <meshBasicMaterial ref={glowRef2} color={dotColor} transparent opacity={0.30}
          depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </Sphere>
      {/* 微弱点光源 */}
      <pointLight color={dotColor} intensity={1.2} distance={5} decay={2} />
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
      <DigitalDust seed={seed} />
      <DistantSun seed={seed} />
      <AsteroidBelt seed={seed} />
      <WarpEffect />

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

      <EffectComposer disableNormalPass>
        <Bloom 
          luminanceThreshold={0.35} 
          mipmapBlur 
          intensity={1.25} 
          levels={9}
          radius={0.8}
        />
        <ChromaticAberration 
          blendFunction={BlendFunction.NORMAL} 
          offset={[0.0012, 0.0012]} 
          radialModulation={true}
          modulationOffset={0.6}
        />
        <Noise opacity={0.045} blendFunction={BlendFunction.OVERLAY} />
        <Vignette eskil={false} offset={0.2} darkness={0.65} blendFunction={BlendFunction.NORMAL} />
        <HueSaturation hue={0} saturation={0.15} blendFunction={BlendFunction.NORMAL} />
      </EffectComposer>
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
