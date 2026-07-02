import * as THREE from "three";

export function mkRng(seed) {
  let s = Math.abs((seed | 0)) || 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

export function _sn(x, y) {
  const d = x * 12.9898 + y * 78.233;
  const s = Math.sin(d) * 43758.5453123;
  return s - Math.floor(s);
}

export function _noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = _sn(ix, iy), b = _sn(ix + 1, iy);
  const c = _sn(ix, iy + 1), d = _sn(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function _fbm(x, y, o) {
  let v = 0, a = 0.5;
  for (let i = 0; i < (o || 6); i++) { v += a * _noise2(x, y); x *= 2.03; y *= 2.03; a *= 0.5; }
  return v;
}

export function hslArr(h, s, l) {
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

const _genQueue = [];
let _isGenerating = false;

export function _processGenQueue() {
  if (_genQueue.length === 0) {
    _isGenerating = false;
    return;
  }
  _isGenerating = true;
  
  const startTime = performance.now();
  while (_genQueue.length > 0 && performance.now() - startTime < 16) {
    const task = _genQueue[0];
    task.process(8);
    if (task.done) {
      _genQueue.shift();
      task.resolve(task.tex);
    }
  }

  requestAnimationFrame(_processGenQueue);
}

export function generatePlanetTextureAsync(hue, sat, seed, resolution = 512, isSun = false) {
  return new Promise((resolve) => {
    const W = resolution * 2, H = resolution; 
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    const rng = mkRng(seed);
    const seedX = rng() * 500, seedY = rng() * 500;
    const styleRoll = rng();
    const TAU = Math.PI * 2;

    const type = isSun ? 3 : (styleRoll < 0.25 ? 0 : styleRoll < 0.50 ? 1 : styleRoll < 0.75 ? 2 : 3);
    const palettes = [
      [
        [hue - 40, Math.min(100, sat + 30), 8], [hue - 15, Math.min(100, sat + 15), 18], [hue +  5, Math.max(20, sat - 10), 38], [hue + 25, Math.min(100, sat + 10), 55], [hue + 45, Math.min(100, sat + 30), 32], [hue - 20, Math.min(100, sat + 40), 12],
      ],
      [
        [hue - 35, Math.min(100, sat + 20),  5], [hue - 15, Math.min(100, sat + 10), 12], [hue, Math.min(100, sat + 30), 22], [hue + 20, Math.min(100, sat + 45), 45], [hue + 40, Math.min(100, sat + 50), 75], [hue +  5, Math.min(100, sat + 15), 18],
      ],
      [
        [hue - 25, Math.max(20, sat - 20), 10], [hue, sat, 28], [hue + 15, Math.min(100, sat +  5), 35], [hue + 25, Math.max(10, sat - 30), 60], [hue -  5, Math.min(100, sat + 20), 45], [hue + 20, Math.max(5,  sat - 40), 95],
      ],
      [
        [hue - 55, Math.min(100, sat + 20),  8], [hue - 25, Math.min(100, sat + 35), 20], [hue, Math.min(100, sat + 40), 35], [hue + 45, Math.min(100, sat + 45), 58], [hue + 75, Math.min(100, sat + 25), 85], [hue +105, Math.min(100, sat + 10), 15],
      ],
      [ // Sun Palette
        [hue - 20, 100, 10], [hue - 10, 100, 25], [hue, 100, 50], [hue + 15, 100, 75], [hue + 30, 100, 95], [hue + 45, 100, 100]
      ]
    ];
    const pal = palettes[isSun ? 4 : type];

    const drawCities = !isSun && rng() > 0.4;
    const hasAtmosphere = !isSun && rng() > 0.1;
    const cloudSeedX = rng() * 100, cloudSeedY = rng() * 100;

    const imgData = x.createImageData(W, H);
    const dd = imgData.data;

    _genQueue.push({
      py: 0, done: false, tex: null, resolve,
      process(chunkLines) {
        const endY = Math.min(this.py + chunkLines, H);
        for (; this.py < endY; this.py++) {
          for (let px = 0; px < W; px++) {
            const u = px / W, v = this.py / H;
            const theta = u * TAU, phi = v * Math.PI;
            const sx = Math.sin(phi) * Math.cos(theta), sy = Math.sin(phi) * Math.sin(theta), sz = Math.cos(phi);

            let n;
            let cityAlpha = 0;

            if (isSun) {
                const ang = Math.atan2(sy, sx);
                const dist = Math.acos(Math.max(-1, Math.min(1, sz)));
                const warp = _fbm(Math.cos(ang)*2 + seedX, Math.sin(ang)*2 + seedY, 5)*4.5;
                n = _fbm(Math.cos(ang*3 + dist*4 + warp)*3 + seedX, Math.sin(ang*3 + dist*4 + warp)*3 + seedY, 7);
                // add turbulent spots
                n += _fbm(sx*15+seedX, sy*15+seedY, 4)*0.3;
                n = Math.pow(Math.max(0, Math.min(1, n)), 1.2) * 1.5;
            } else if (type === 0) {
              const warp1 = _fbm(sx * 4 + seedX, sy * 4 + seedY, 5) * 1.5;
              const band = Math.sin(sz * 15.0 * Math.PI + _fbm(sx * 8 + warp1, sy * 8 + warp1, 6) * 4.5) * 0.5 + 0.5;
              const turb = _fbm(sx * 15 + seedX + 99, sy * 15 + sz * 5 + seedY + 77, 6);
              n = Math.pow(band * 0.70 + turb * 0.30, 1.2); 
            } else if (type === 1) {
              const ridge0 = 1.0 - Math.abs(_fbm(sx * 3 + seedX, sy * 3 + sz * 2 + seedY, 6) * 2 - 1);
              const ridge1 = 1.0 - Math.abs(_fbm(sx * 12 + seedX + 55, sy * 12 + sz * 8 + seedY + 33, 6) * 2 - 1);
              const base = Math.pow(_fbm(sx * 4 + seedX + 7, sy * 4 + sz + seedY + 11, 7), 1.5);
              const crack = Math.pow(ridge1, 4.5); 
              n = (base * 0.5 + Math.pow(ridge0, 2) * 0.4) * (1 - crack * 0.5) + crack * 0.8;
              n = Math.max(0, Math.min(1, n * 1.3 - 0.15));
            } else if (type === 2) {
              const base = _fbm(sx * 3 + seedX, sy * 3 + sz + seedY, 8); 
              let land = base > 0.48 ? 0.5 + Math.pow(base - 0.48, 0.8) * 1.5 : base * 0.8; 
              const polar = Math.pow(Math.abs(sz), 3.0);
              n = Math.max(land, polar * 1.1) * 0.85 + _fbm(sx * 20 + seedX + 88, sy * 20 + sz * 15 + seedY + 44, 4) * 0.15;
            } else {
              const ang  = Math.atan2(sy, sx);
              const dist = Math.acos(Math.max(-1, Math.min(1, sz)));
              const warp = _fbm(Math.cos(ang) * 4 + seedX, Math.sin(ang) * 4 + seedY, 5) * 3.5;
              n = _fbm(Math.cos(ang * 2 + dist * 8 + warp) * 3.5 + seedX, Math.sin(ang * 2 + dist * 8 + warp) * 3.5 + seedY, 7);
              n = Math.pow(n, 1.4) * 1.2;
            }

            if (drawCities && n > 0.45 && n < 0.65 && type !== 0) {
              const cityNoise = Math.pow(_fbm(sx * 60 + seedX, sy * 60 + seedY, 4), 5.5);
              if (cityNoise > 0.3) { cityAlpha = (cityNoise - 0.3) * 4.0; }
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

            if (cityAlpha > 0) { lL = Math.max(lL, 50) + cityAlpha * 60; }
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

          if (!isSun) {
              const addRing = rng() > 0.6;
              if (addRing) {
                const ringW = 4 + rng() * 6; 
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

              const shine = x.createRadialGradient(W * 0.7, H * 0.3, 0, W * 0.5, H * 0.5, W * 0.4);
              shine.addColorStop(0,    `hsla(${hue + 15}, ${sat}%, 90%, 0.15)`); 
              shine.addColorStop(0.4,  `hsla(${hue}, ${sat}%, 60%, 0.05)`);
              shine.addColorStop(0.6,  "hsla(0,0%,0%,0)");
              shine.addColorStop(1,    `hsla(240, 50%, 10%, 0.4)`); 
              x.fillStyle = shine; x.fillRect(0, 0, W, H);

              const pg = x.createLinearGradient(0, 0, 0, H);
              pg.addColorStop(0,    `hsla(${hue + 35}, ${Math.min(100, sat + 12)}%, 80%, 0.38)`);
              pg.addColorStop(0.18, "hsla(0,0%,0%,0)");
              pg.addColorStop(0.82, "hsla(0,0%,0%,0)");
              pg.addColorStop(1,    `hsla(${hue - 18}, ${Math.min(100, sat + 10)}%, 62%, 0.30)`);
              x.fillStyle = pg; x.fillRect(0, 0, W, H);

              const feats = 2 + Math.floor(rng() * 6);
              for (let i = 0; i < feats; i++) {
                const fx  = rng() * W;
                const fy  = H * 0.15 + rng() * H * 0.70;
                const fr  = (8 + rng() * 60) * (W / 1024); 
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
          }

          const tex = new THREE.CanvasTexture(c);
          tex.anisotropy = 16;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          this.tex = tex;
          this.done = true;
        }
      }
    });

    if (!_isGenerating) {
      _processGenQueue();
    }
  });
}