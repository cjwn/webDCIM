/**
 * 原生 1:1 像素级清晰度 / 糊片指数 & 真合焦峰值对焦
 *
 * 设计要点：
 *   1) 对比度无关边缘宽度（width = Contrast / Slope）：高反差但糊掉的黑框配白墙不会被误判清晰。
 *   2) 原生 1:1 采样：
 *      - 原图模式（自然边长 >= 3000px）：浏览器直接从已解码的 <img> 截取 8×6 个 224×224 原生 1:1 块计算（~35ms，零网络开销）。
 *      - 高清预览 2048 模式：高像素原图（如 A7R5 61MP）缩到 2048px 后轻中度失焦会被缩图抹平，
 *        因此异步请求 /api/sharpness 在服务端对原文件做完全相同的 1:1 原生块分析（带 LRU 缓存）。
 *   3) 峰值对焦（P）使用 8×6 真实 1:1 边缘宽度图作为空间硬门槛，失焦区域绝不乱亮绿点。
 */
'use strict';

const PEAK_MAP_DIM = 800;
const PEAK_LEVELS = [
  { key: 'strict', label: '严格', maxW: 1.48, floor: 0.22, pct: 0.015 },
  { key: 'normal', label: '标准', maxW: 1.82, floor: 0.16, pct: 0.030 },
  { key: 'loose',  label: '宽松', maxW: 2.05, floor: 0.11, pct: 0.050 },
];

let lbSharpEnabled = (() => {
  try {
    const v = localStorage.getItem('lbSharpOn');
    return v === null ? true : v === '1';
  } catch { return true; }
})();
let focusPeakOn = false;
let focusPeakLevelIdx = (() => {
  try {
    const saved = localStorage.getItem('focusPeakLevel');
    const idx = PEAK_LEVELS.findIndex((x) => x.key === saved);
    if (idx >= 0) return idx;
  } catch {}
  return 1; // 默认：标准
})();

let lbSharpToken = 0;
let lbCurrentSharp = null;    // { score, grade, bestW, noiseSigma, motionSuspected, motionDir, cols, rows, tileWidths, sharpTiles, dims, src, ms }
let lbCurrentExif = null;
let lbCurrentPeakData = null; // { w, h, crispMap: Float32Array, maxCrisp: number }
let lbPatchCanvas = null;
let lbPeakOffscreen = null;
const lbSharpCache = new Map(); // rel -> sharpness meta (incl. 48-element tileWidths)

function lbHidePeakCanvas() {
  const pk = $('#lbPeakCanvas');
  if (pk) pk.classList.remove('show');
}
function lbResetSharpState() {
  lbSharpToken++;
  lbCurrentSharp = null;
  lbCurrentExif = null;
  lbCurrentPeakData = null;
  const pk = $('#lbPeakCanvas');
  if (pk) pk.remove();
}
function lbSyncPeakBox() {
  const pk = $('#lbPeakCanvas');
  if (!pk || !lbView) return;
  const rs = lbView.renderScale || 1;
  pk.style.transition = 'none';
  pk.style.width = (lbView.nw * rs) + 'px';
  pk.style.height = (lbView.nh * rs) + 'px';
}
function syncPeakUI() {
  const bMain = $('#btnFocusPeak');
  const bLv = $('#btnPeakLevel');
  const lv = PEAK_LEVELS[focusPeakLevelIdx] || PEAK_LEVELS[1];
  if (bMain) bMain.classList.toggle('active', focusPeakOn);
  if (bLv) {
    bLv.textContent = lv.label;
    bLv.classList.toggle('on', focusPeakOn);
  }
}
function syncSharpToggleUI() {
  const btn = $('#btnSharpToggle');
  if (!btn) return;
  btn.classList.toggle('active', lbSharpEnabled);
  btn.setAttribute('aria-pressed', lbSharpEnabled ? 'true' : 'false');
  btn.title = lbSharpEnabled ? '已开启清晰度分析（点击关闭以跳过计算）' : '点击开启清晰度分析';
}

function parseExifSlowShutter(exif) {
  if (!exif || !exif.focal || !exif.shutter) return null;
  const fm = String(exif.focal).match(/(\d+(?:\.\d+)?)/);
  if (!fm) return null;
  const focalMm = parseFloat(fm[1]);
  if (!Number.isFinite(focalMm) || focalMm <= 0) return null;
  const sStr = String(exif.shutter).trim();
  let sec = NaN;
  const frac = sStr.match(/^1\s*\/\s*(\d+(?:\.\d+)?)/);
  if (frac) {
    const denom = parseFloat(frac[1]);
    if (denom > 0) sec = 1 / denom;
  } else {
    const dec = sStr.match(/^(\d+(?:\.\d+)?)/);
    if (dec) sec = parseFloat(dec[1]);
  }
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const safeSec = 1.25 / Math.max(24, focalMm);
  if (sec > safeSec) {
    return `快门偏慢 (${sStr} @ ${Math.round(focalMm)}mm)`;
  }
  return null;
}

function renderLbSharpUI() {
  syncSharpToggleUI();
  const el = $('#lbSharp');
  if (!el) return;
  if (!lbSharpEnabled) {
    el.style.color = 'var(--fg3)';
    el.textContent = '未开启';
    return;
  }
  const s = lbCurrentSharp;
  if (!s) return;
  const cls = s.score >= 65 ? 'good' : (s.score >= 42 ? 'mid' : 'bad');
  const notes = [];
  if (s.backFocus) notes.push(`疑似跑焦（背景 ${s.bgScore}）`);
  if (s.motionSuspected) notes.push(`疑似${s.motionDir}手抖拖影`);
  if (s.score < 65) {
    const slow = parseExifSlowShutter(lbCurrentExif);
    if (slow) notes.push(slow);
  }
  const isFace = s.mode === 'face';
  const tip = isFace
    ? `YuNet 人脸眼部 1:1 各向同性锐度（${s.dims || ''}）\n` +
      `眼带边缘宽 ${s.bestW}px（≤1.8 锐利 / ≥2.8 模糊）· 背景最锐 ${s.bgScore} 分\n` +
      `噪声估计 σ=${s.noiseSigma} · 耗时 ${s.ms}ms`
    : `对比度无关边缘宽度（${s.src || '1:1'} · ${s.dims || ''}）\n` +
      `最锐边缘宽 ${s.bestW}px（≤1.5 锐利 / ≥2.0 模糊）· 合焦区 ${s.sharpTiles}/48 块\n` +
      `噪声估计 σ=${s.noiseSigma} · 耗时 ${s.ms}ms`;
  const badgePrefix = isFace ? '👤 ' : '';
  el.style.color = '';
  el.innerHTML = `<span class="sharp-badge ${cls}" title="${escHtml(tip)}">${badgePrefix}${s.score} · ${s.grade}</span>` +
    (notes.length ? `<span class="sharp-sub">${escHtml(notes.join(' · '))}</span>` : '');
}

/**
 * 测量单个 1:1 原生像素块的对比度无关边缘宽度（与 lib/sharpness.js 完全一致的数学公式）
 */
function measurePatchEdgeWidth(rgba, w, h) {
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
  }
  const sm = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      sm[r1 + x] = (
        gray[r0 + x - 1] + 2 * gray[r0 + x] + gray[r0 + x + 1] +
        2 * gray[r1 + x - 1] + 4 * gray[r1 + x] + 2 * gray[r1 + x + 1] +
        gray[r2 + x - 1] + 2 * gray[r2 + x] + gray[r2 + x + 1]
      ) * 0.0625;
    }
  }

  let nSum = 0, nCnt = 0;
  for (let y = 2; y < h - 2; y += 2) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 2; x < w - 2; x += 2) {
      const lum = sm[r1 + x];
      if (lum < 8 || lum > 248) continue;
      nSum += Math.abs(
        gray[r0 + x - 1] - 2 * gray[r0 + x] + gray[r0 + x + 1] -
        2 * gray[r1 + x - 1] + 4 * gray[r1 + x] - 2 * gray[r1 + x + 1] +
        gray[r2 + x - 1] - 2 * gray[r2 + x] + gray[r2 + x + 1]
      );
      nCnt++;
    }
  }
  const noiseSigma = (nCnt > 16 ? nSum / nCnt : 0) * 0.2089;

  let minL = 255, maxL = 0;
  for (let i = 0; i < n; i += 4) {
    const v = sm[i];
    if (v < minL) minL = v;
    if (v > maxL) maxL = v;
  }
  const darkFactor = Math.min(1, Math.max(15, maxL - minL) / 120);

  const gxArr = new Float32Array(n), gyArr = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 2; y < h - 2; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 2; x < w - 2; x++) {
      const idx = r1 + x;
      const gx = (-sm[r0 + x - 1] + sm[r0 + x + 1] - 2 * sm[r1 + x - 1] + 2 * sm[r1 + x + 1] - sm[r2 + x - 1] + sm[r2 + x + 1]) * 0.25;
      const gy = (-sm[r0 + x - 1] - 2 * sm[r0 + x] - sm[r0 + x + 1] + sm[r2 + x - 1] + 2 * sm[r2 + x] + sm[r2 + x + 1]) * 0.25;
      gxArr[idx] = gx; gyArr[idx] = gy;
      mag[idx] = Math.hypot(gx, gy);
    }
  }

  const sampleSm = (fx, fy) => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return -1;
    const dx = fx - x0, dy = fy - y0;
    const i00 = y0 * w + x0;
    return (sm[i00] * (1 - dx) + sm[i00 + 1] * dx) * (1 - dy) +
           (sm[i00 + w] * (1 - dx) + sm[i00 + w + 1] * dx) * dy;
  };

  const widths = [], wx = [], wy = [];
  const gate = Math.max(3.5 * darkFactor + 1.5, noiseSigma * 3.8);
  const minC = Math.max(10 * darkFactor + 6, noiseSigma * 7.5);

  for (let y = 14; y < h - 14; y += 2) {
    for (let x = 14; x < w - 14; x += 2) {
      const idx = y * w + x;
      const m = mag[idx];
      if (m < gate) continue;
      const gx = gxArr[idx], gy = gyArr[idx];
      const ux = gx / m, uy = gy / m;
      const m1 = mag[Math.round(y + uy) * w + Math.round(x + ux)];
      const m2 = mag[Math.round(y - uy) * w + Math.round(x - ux)];
      if (m < m1 || m < m2) continue;

      let prev = sm[idx];
      for (let s = 1; s <= 18; s++) {
        const v = sampleSm(x + ux * s, y + uy * s);
        if (v < 0 || v <= prev + 0.25) break;
        prev = v;
      }
      const hi = prev;
      prev = sm[idx];
      for (let s = 1; s <= 18; s++) {
        const v = sampleSm(x - ux * s, y - uy * s);
        if (v < 0 || v >= prev - 0.25) break;
        prev = v;
      }
      const lo = prev;
      const C = hi - lo;
      if (C < minC) continue;

      const ew = C / m;
      widths.push(ew);
      const agx = Math.abs(gx), agy = Math.abs(gy);
      if (agx > agy * 1.7) wx.push(ew);
      else if (agy > agx * 1.7) wy.push(ew);
    }
  }
  if (widths.length < 12) return null;
  widths.sort((a, b) => a - b);
  wx.sort((a, b) => a - b);
  wy.sort((a, b) => a - b);
  const p25 = widths[Math.floor(widths.length * 0.25)];
  const p25X = wx.length >= 8 ? wx[Math.floor(wx.length * 0.25)] : 0;
  const p25Y = wy.length >= 8 ? wy[Math.floor(wy.length * 0.25)] : 0;
  return { cnt: widths.length, p25, p25X, p25Y, noiseSigma };
}

/**
 * 浏览器本地原生 1:1 采样分析（原图模式直接用，无需请求服务端，约 30~50ms）
 */
function analyzeNativeImgLocal(img) {
  const t0 = performance.now();
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return null;
  const cols = W >= H ? 8 : 6;
  const rows = W >= H ? 6 : 8;
  const pw = Math.min(240, Math.max(48, Math.floor(W / cols)));
  const ph = Math.min(240, Math.max(48, Math.floor(H / rows)));
  if (!lbPatchCanvas) lbPatchCanvas = document.createElement('canvas');
  lbPatchCanvas.width = pw;
  lbPatchCanvas.height = ph;
  const ctx = lbPatchCanvas.getContext('2d', { willReadFrequently: true });

  const tileWidths = new Array(cols * rows).fill(9.9);
  const tiles = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.min(W - pw, Math.floor((c + 0.5) * (W / cols) - pw / 2)));
      const y0 = Math.max(0, Math.min(H - ph, Math.floor((r + 0.5) * (H / rows) - ph / 2)));
      ctx.drawImage(img, x0, y0, pw, ph, 0, 0, pw, ph);
      const rgba = ctx.getImageData(0, 0, pw, ph).data;
      const m = measurePatchEdgeWidth(rgba, pw, ph);
      if (m) {
        tileWidths[r * cols + c] = Math.round(m.p25 * 100) / 100;
        tiles.push({ r, c, ...m });
      }
    }
  }

  tiles.sort((a, b) => a.p25 - b.p25);
  const weights = [0.45, 0.35, 0.20];
  let bestW = 9.9, wSum = 0, noiseSum = 0;
  if (tiles.length) {
    bestW = 0;
    const kMax = Math.min(3, tiles.length);
    for (let k = 0; k < kMax; k++) {
      bestW += tiles[k].p25 * weights[k];
      wSum += weights[k];
      noiseSum += tiles[k].noiseSigma;
    }
    bestW /= wSum;
    noiseSum /= kMax;
  }

  let sumX = 0, cntX = 0, sumY = 0, cntY = 0;
  for (let k = 0; k < Math.min(8, tiles.length); k++) {
    if (tiles[k].p25X) { sumX += tiles[k].p25X; cntX++; }
    if (tiles[k].p25Y) { sumY += tiles[k].p25Y; cntY++; }
  }
  const avgX = cntX ? sumX / cntX : 0;
  const avgY = cntY ? sumY / cntY : 0;

  let motionSuspected = false, motionDir = '';
  let effectiveW = bestW;
  if (avgX && avgY) {
    const worstAxis = Math.max(avgX, avgY);
    const bestAxis = Math.min(avgX, avgY);
    const ratio = worstAxis / bestAxis;
    const diff = worstAxis - bestAxis;
    if ((bestW >= 1.48 && worstAxis >= 2.70 && ratio >= 1.45 && diff >= 0.85) || (worstAxis >= 3.50 && ratio >= 2.00)) {
      motionSuspected = true;
      motionDir = avgX > avgY ? '横向' : '纵向';
      effectiveW = Math.max(bestW, 0.25 * bestW + 0.75 * worstAxis);
      const minFloorW = Math.round(effectiveW * 0.85 * 100) / 100;
      for (let i = 0; i < tileWidths.length; i++) {
        if (tileWidths[i] < minFloorW) tileWidths[i] = minFloorW;
      }
    }
  }

  const score = Math.round(Math.max(1, Math.min(99, 100 / (1 + Math.exp((effectiveW - 1.90) * 3.2)))));
  const grade = score >= 65 ? '清晰' : (score >= 42 ? '一般' : '疑似糊片');
  const sharpTiles = tileWidths.filter((w) => w <= 1.82).length;

  return {
    dims: `${W}×${H}`,
    score,
    grade,
    bestW: Math.round(effectiveW * 100) / 100,
    noiseSigma: Math.round(noiseSum * 10) / 10,
    motionSuspected,
    motionDir,
    cols,
    rows,
    tileWidths,
    sharpTiles,
    src: Math.max(W, H) >= 3000 ? '1:1 原生像素' : '预览像素',
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * 为峰值对焦生成对比度归一化的边缘锐度底图（最长边 800px，约 12ms）
 */
function buildPeakCrispMap(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return null;
  const scale = Math.min(1, PEAK_MAP_DIM / Math.max(nw, nh));
  const w = Math.max(32, Math.round(nw * scale));
  const h = Math.max(32, Math.round(nh * scale));
  if (!lbPeakOffscreen) lbPeakOffscreen = document.createElement('canvas');
  lbPeakOffscreen.width = w;
  lbPeakOffscreen.height = h;
  const ctx = lbPeakOffscreen.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
  }
  const sm = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      sm[r1 + x] = (
        gray[r0 + x - 1] + 2 * gray[r0 + x] + gray[r0 + x + 1] +
        2 * gray[r1 + x - 1] + 4 * gray[r1 + x] + 2 * gray[r1 + x + 1] +
        gray[r2 + x - 1] + 2 * gray[r2 + x] + gray[r2 + x + 1]
      ) * 0.0625;
    }
  }

  const crispMap = new Float32Array(n);
  let maxCrisp = 0;
  for (let y = 2; y < h - 2; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 2; x < w - 2; x++) {
      const idx = r1 + x;
      const gx = (-sm[r0 + x - 1] + sm[r0 + x + 1] - 2 * sm[r1 + x - 1] + 2 * sm[r1 + x + 1] - sm[r2 + x - 1] + sm[r2 + x + 1]) * 0.25;
      const gy = (-sm[r0 + x - 1] - 2 * sm[r0 + x] - sm[r0 + x + 1] + sm[r2 + x - 1] + 2 * sm[r2 + x] + sm[r2 + x + 1]) * 0.25;
      const m = Math.hypot(gx, gy);
      if (m < 7) continue;
      // 对比度归一化：二阶拉普拉斯 / 一阶梯度，抑制纯靠黑白大反差抢镜头的边缘
      const lap = Math.abs(
        sm[r0 + x] + sm[r2 + x] + sm[r1 + x - 1] + sm[r1 + x + 1] - 4 * sm[idx]
      );
      const strengthW = Math.min(1, m / 26);
      const val = (lap / (m + 8)) * strengthW;
      crispMap[idx] = val;
      if (val > maxCrisp) maxCrisp = val;
    }
  }
  return { w, h, crispMap, maxCrisp };
}

function sampleTileWidthBilinear(meta, fx, fy) {
  if (!meta || !meta.tileWidths || !meta.cols || !meta.rows) return 1.5;
  const cols = meta.cols, rows = meta.rows, tw = meta.tileWidths;
  const gx = fx * cols - 0.5;
  const gy = fy * rows - 0.5;
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(gy)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const dx = Math.max(0, Math.min(1, gx - x0));
  const dy = Math.max(0, Math.min(1, gy - y0));
  const w00 = tw[y0 * cols + x0], w10 = tw[y0 * cols + x1];
  const w01 = tw[y1 * cols + x0], w11 = tw[y1 * cols + x1];
  return (w00 * (1 - dx) + w10 * dx) * (1 - dy) + (w01 * (1 - dx) + w11 * dx) * dy;
}

function renderFocusPeakingOverlay() {
  if (!focusPeakOn || !lbCurrentPeakData || !lbView) {
    lbHidePeakCanvas();
    return;
  }
  const canvasEl = $('#lbCanvas');
  if (!canvasEl) return;
  let pk = $('#lbPeakCanvas');
  if (!pk) {
    pk = document.createElement('canvas');
    pk.id = 'lbPeakCanvas';
    canvasEl.appendChild(pk);
  }
  const { w, h, crispMap } = lbCurrentPeakData;
  const lv = PEAK_LEVELS[focusPeakLevelIdx] || PEAK_LEVELS[1];
  const meta = lbCurrentSharp;

  pk.width = w;
  pk.height = h;
  const ctx = pk.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  const out = imgData.data;

  // 先结合 1:1 空间合焦宽度遮罩（tileWidths）计算每个像素的真实合焦权重
  const total = w * h;
  const weighted = new Float32Array(total);
  const BINS = 256;
  const hist = new Int32Array(BINS);
  let maxVal = 0;

  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / h;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      const c = crispMap[idx];
      if (c <= lv.floor) continue;
      // 用 1:1 原生边缘宽度做空间硬门槛：失焦块直接归零，绝不给糊掉的物体亮绿点
      const tileW = sampleTileWidthBilinear(meta, (x + 0.5) / w, fy);
      if (tileW >= lv.maxW) continue;
      const focusW = Math.min(1, Math.max(0.18, (lv.maxW - tileW) / Math.max(0.35, lv.maxW - 1.15)));
      const v = c * focusW;
      if (v <= lv.floor) continue;
      weighted[idx] = v;
      if (v > maxVal) maxVal = v;
    }
  }

  if (maxVal > lv.floor) {
    const cap = Math.max(lv.floor * 2.5, maxVal);
    const invScale = (BINS - 1) / cap;
    for (let i = 0; i < total; i++) {
      const v = weighted[i];
      if (v <= lv.floor) continue;
      let b = (v * invScale) | 0;
      if (b >= BINS) b = BINS - 1;
      hist[b]++;
    }
    const targetPx = Math.max(100, Math.floor(total * lv.pct));
    let acc = 0, thresh = lv.floor;
    for (let b = BINS - 1; b >= 0; b--) {
      acc += hist[b];
      if (acc >= targetPx) {
        thresh = Math.max(lv.floor, b / invScale);
        break;
      }
    }
    const denom = Math.max(0.12, (maxVal - thresh) * 0.85);
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const v = weighted[i];
      if (v <= thresh) continue;
      const t = Math.min(1, (v - thresh) / denom);
      out[p]     = (40 + t * 110) | 0;
      out[p + 1] = 255;
      out[p + 2] = (145 + t * 75) | 0;
      out[p + 3] = (115 + t * 125) | 0;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // 若检出人脸，在峰值图层上绘制相机眼控风格的四角对焦框，直观标出人脸评估区
  if (meta && meta.faceBox) {
    const fb = meta.faceBox;
    const fx = fb.x * w, fy = fb.y * h, fw = fb.w * w, fh = fb.h * h;
    const corner = Math.max(6, Math.min(18, Math.min(fw, fh) * 0.25));
    ctx.strokeStyle = meta.score >= 65 ? 'rgba(78, 230, 168, 0.92)'
      : (meta.score >= 42 ? 'rgba(255, 209, 102, 0.92)' : 'rgba(255, 118, 118, 0.92)');
    ctx.lineWidth = Math.max(1.5, w / 420);
    ctx.beginPath();
    // 左上
    ctx.moveTo(fx, fy + corner); ctx.lineTo(fx, fy); ctx.lineTo(fx + corner, fy);
    // 右上
    ctx.moveTo(fx + fw - corner, fy); ctx.lineTo(fx + fw, fy); ctx.lineTo(fx + fw, fy + corner);
    // 左下
    ctx.moveTo(fx, fy + fh - corner); ctx.lineTo(fx, fy + fh); ctx.lineTo(fx + corner, fy + fh);
    // 右下
    ctx.moveTo(fx + fw - corner, fy + fh); ctx.lineTo(fx + fw, fy + fh); ctx.lineTo(fx + fw, fy + fh - corner);
    ctx.stroke();
  }

  lbSyncPeakBox();
  pk.classList.add('show');
  lbApply();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pk) pk.style.transition = '';
  }));
}

async function fetchServerSharpness(rel) {
  if (!rel) return null;
  try {
    const r = await fetch('/api/sharpness?rel=' + enc(rel) + '&v=5');
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.ok && d.sharpness) ? d.sharpness : null;
  } catch {
    return null;
  }
}

function scheduleLbSharpness(img, g, isClipOverlay) {
  if (!img || !g || isVideoGroup(g)) return;
  if (!lbSharpEnabled && !focusPeakOn) {
    renderLbSharpUI();
    return;
  }
  if (isClipOverlay) {
    if (lbCurrentSharp) renderLbSharpUI();
    if (focusPeakOn && lbCurrentPeakData) {
      lbSyncPeakBox();
      const pk = $('#lbPeakCanvas');
      if (pk) pk.classList.add('show');
      lbApply();
    }
    return;
  }

  const token = ++lbSharpToken;
  const targetRel = exifRelFor(g) || g.main.rel;
  const cached = lbSharpCache.get(targetRel);

  const finishWithMeta = (meta) => {
    if (token !== lbSharpToken) return;
    if (!meta) {
      const el = $('#lbSharp');
      if (el && lbSharpEnabled && !lbCurrentSharp) el.textContent = '无';
      return;
    }
    lbCurrentSharp = meta;
    lbSharpCache.set(targetRel, meta);
    if (lbSharpCache.size > 300) lbSharpCache.delete(lbSharpCache.keys().next().value);
    renderLbSharpUI();
    if (focusPeakOn) {
      if (!lbCurrentPeakData && lbView && lbView.img === img) {
        lbCurrentPeakData = buildPeakCrispMap(img);
      }
      renderFocusPeakingOverlay();
    }
  };

  if (cached) {
    finishWithMeta(cached);
    return;
  }

  requestAnimationFrame(() => {
    setTimeout(async () => {
      if (token !== lbSharpToken) return;
      if (!lbView || lbView.img !== img) return;
      try {
        // 优先走服务端 1:1 + YuNet 人脸眼部识别（原图和高清预览统一口径，带 LRU 缓存）
        let meta = await fetchServerSharpness(targetRel);
        if (!meta && token === lbSharpToken && lbView && lbView.img === img) {
          meta = analyzeNativeImgLocal(img);
        }
        finishWithMeta(meta);
      } catch {
        const el = $('#lbSharp');
        if (el && lbSharpEnabled && !lbCurrentSharp) el.textContent = '无';
      }
    }, 0);
  });
}

function toggleLbSharpness() {
  lbSharpEnabled = !lbSharpEnabled;
  try { localStorage.setItem('lbSharpOn', lbSharpEnabled ? '1' : '0'); } catch {}
  syncSharpToggleUI();
  if (!lbSharpEnabled) {
    if (!focusPeakOn) lbSharpToken++;
    renderLbSharpUI();
    return;
  }
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || isVideoGroup(g)) return;
  const targetRel = exifRelFor(g) || g.main.rel;
  if (lbCurrentSharp) {
    renderLbSharpUI();
    return;
  }
  const cached = lbSharpCache.get(targetRel);
  if (cached) {
    lbCurrentSharp = cached;
    renderLbSharpUI();
    return;
  }
  if (rawClip) {
    toast('请先关闭溢出检查 [G] 再分析清晰度');
    return;
  }
  const el = $('#lbSharp');
  if (el) { el.style.color = 'var(--fg3)'; el.textContent = '分析中…'; }
  if (lbView && lbView.img) {
    scheduleLbSharpness(lbView.img, g, false);
  }
}

function toggleFocusPeaking() {
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || isVideoGroup(g)) return;
  focusPeakOn = !focusPeakOn;
  syncPeakUI();
  if (!focusPeakOn) {
    lbHidePeakCanvas();
    return;
  }
  if (rawClip && !lbCurrentPeakData) {
    toast('请先关闭溢出检查 [G] 再生成峰值对焦');
    return;
  }
  if (lbCurrentSharp && lbCurrentPeakData) {
    renderFocusPeakingOverlay();
  } else if (lbView && lbView.img) {
    if (!lbCurrentSharp) {
      scheduleLbSharpness(lbView.img, g, false);
    } else {
      lbCurrentPeakData = buildPeakCrispMap(lbView.img);
      renderFocusPeakingOverlay();
    }
  }
}

function cyclePeakLevel() {
  focusPeakLevelIdx = (focusPeakLevelIdx + 1) % PEAK_LEVELS.length;
  try { localStorage.setItem('focusPeakLevel', PEAK_LEVELS[focusPeakLevelIdx].key); } catch {}
  if (!focusPeakOn) focusPeakOn = true;
  syncPeakUI();
  if (lbCurrentSharp && lbCurrentPeakData) {
    renderFocusPeakingOverlay();
  } else if (lbView && lbView.img && !rawClip) {
    const g = (window._shownGroups || [])[lbIndex];
    if (g) scheduleLbSharpness(lbView.img, g, false);
  }
}
$('#btnFocusPeak').addEventListener('click', toggleFocusPeaking);
$('#btnPeakLevel').addEventListener('click', cyclePeakLevel);
