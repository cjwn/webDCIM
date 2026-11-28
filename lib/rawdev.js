'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

// 预计算 sRGB <-> Linear 查找表，避免像素循环里重复调用 Math.pow
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  SRGB_TO_LIN[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
const LIN_LUT_SIZE = 16384;
const LIN_TO_SRGB = new Uint8Array(LIN_LUT_SIZE + 1);
for (let i = 0; i <= LIN_LUT_SIZE; i++) {
  const l = i / LIN_LUT_SIZE;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  LIN_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** 解析 dcraw_emu 输出的 16-bit 大端二进制 PPM (P6) */
function parsePpm16(buf) {
  if (!buf || buf.length < 15 || buf[0] !== 0x50 || buf[1] !== 0x36) return null; // "P6"
  let idx = 2;
  const limit = Math.min(buf.length, 512);
  const tokens = [];
  const isWs = (b) => b === 32 || b === 10 || b === 13 || b === 9;
  while (tokens.length < 3 && idx < limit) {
    while (idx < limit && isWs(buf[idx])) idx++;
    if (idx < limit && buf[idx] === 35) { // '#' 注释行
      while (idx < limit && buf[idx] !== 10) idx++;
      continue;
    }
    const start = idx;
    while (idx < limit && !isWs(buf[idx])) idx++;
    if (start < idx) tokens.push(buf.toString('ascii', start, idx));
  }
  if (tokens.length !== 3) return null;
  const w = parseInt(tokens[0], 10);
  const h = parseInt(tokens[1], 10);
  const maxv = parseInt(tokens[2], 10);
  if (!(w > 0 && h > 0 && maxv === 65535)) return null;
  const offset = idx + 1;
  if (offset + w * h * 6 > buf.length) return null;
  return { w, h, offset };
}

/**
 * 基于 Fritsch-Carlson 单调三次 Hermite 样条（PCHIP）从 1D 线性分布对拟合平滑机内 Tone Curve。
 * 只拟合参考 JPG 未裁切的有效区间（sRGB 8..235），高于最高控制点的高光无缝衔接 C1 软肩滚降。
 */
function fitCameraToneCurve(embSamples, rawScaled, loVal = SRGB_TO_LIN[8], hiVal = SRGB_TO_LIN[235]) {
  const en = embSamples.length;
  const rn = rawScaled.length;
  if (en < 64 || rn < 64) return null;

  let loIdx = 0;
  while (loIdx < en && embSamples[loIdx] < loVal) loIdx++;
  let hiIdx = en - 1;
  while (hiIdx > loIdx && embSamples[hiIdx] > hiVal) hiIdx--;

  if (hiIdx - loIdx < Math.max(32, en * 0.10)) return null;

  const xs = [0];
  const ys = [0];
  for (const f of [0.04, 0.16, 0.32, 0.50, 0.68, 0.84, 0.96]) {
    const q = (loIdx + f * (hiIdx - loIdx)) / (en - 1);
    const xRaw = rawScaled[Math.min(rn - 1, Math.max(0, Math.round(q * (rn - 1))))];
    const yRaw = embSamples[Math.min(en - 1, Math.max(0, Math.round(q * (en - 1))))];
    if (!(xRaw > 0.002 && yRaw > 0.002 && yRaw <= 0.88)) continue;
    const xPrev = xs[xs.length - 1];
    const yPrev = ys[ys.length - 1];
    const dx = xRaw - xPrev;
    if (dx < 0.012) continue;
    const yBound = Math.min(xRaw * 2.2, Math.max(xRaw * 0.45, yRaw));
    const slope = Math.min(2.6, Math.max(0.35, (yBound - yPrev) / dx));
    const yNext = yPrev + slope * dx;
    if (yNext > 0.90) break;
    xs.push(xRaw);
    ys.push(yNext);
  }

  const n = xs.length;
  if (n < 4 || ys[n - 1] < 0.15) return null;

  const d = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    d[k] = (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
  }
  const m = new Float64Array(n);
  m[0] = Math.min(2.4, Math.max(0.35, d[0]));
  for (let k = 1; k < n - 1; k++) {
    const h0 = xs[k] - xs[k - 1];
    const h1 = xs[k + 1] - xs[k];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  m[n - 1] = Math.min(1.35, Math.max(0.35, d[n - 2]));

  return { xs, ys, m, xLast: xs[n - 1], yLast: ys[n - 1], sLast: m[n - 1] };
}

/** 计算经过机内 Tone Curve（或默认肩部曲线）映射后的输出线性值（严格单调、C1 连续趋近 1.0） */
function evalCameraToneCurve(curve, x, hl = 0) {
  if (x <= 0) return 0;
  if (!curve) {
    const knee = Math.max(0.32, 0.72 - 0.22 * hl);
    return x > knee ? knee + (1 - knee) * ((x - knee) / ((x - knee) + (1 - knee))) : x;
  }
  const { xs, ys, m, xLast, yLast, sLast } = curve;
  if (x >= xLast) {
    const head = Math.max(0.05, 1 - yLast);
    const num = sLast * (x - xLast);
    return yLast + head * (num / (num + head));
  }
  let k = 0;
  const lastSeg = xs.length - 2;
  while (k < lastSeg && x > xs[k + 1]) k++;
  const h = xs[k + 1] - xs[k];
  const t = (x - xs[k]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[k]
    + (t3 - 2 * t2 + t) * h * m[k]
    + (-2 * t3 + 3 * t2) * ys[k + 1]
    + (t3 - t2) * h * m[k + 1];
}

/** 3x3 线性方程组求解（用于中心色彩适配矩阵拟合） */
function solve3x3(A, b) {
  const M = [
    [A[0], A[1], A[2], b[0]],
    [A[3], A[4], A[5], b[1]],
    [A[6], A[7], A[8], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-10) return null;
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const div = M[col][col];
    for (let j = col; j < 4; j++) M[col][j] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j < 4; j++) M[r][j] -= f * M[col][j];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

/**
 * 拟合中心 60% 区域的正则化 3x3 色彩适配矩阵（亮度解耦：消除 Tone Curve 弯曲干扰，只学色相/饱和度/微白平衡）。
 * 自动把 LibRaw 开源色彩矩阵拉向当前相机的机内直出色彩科学；若画幅裁切不匹配或未显著降低色差，安全返回 null。
 */
function fitColorMatrix3x3(rawRgb, embRgb, ew, eh) {
  const x0 = Math.floor(ew * 0.2), x1 = Math.max(x0 + 1, Math.floor(ew * 0.8));
  const y0 = Math.floor(eh * 0.2), y1 = Math.max(y0 + 1, Math.floor(eh * 0.8));
  const loEmb = SRGB_TO_LIN[18];
  const hiEmb = SRGB_TO_LIN[228];

  const XtX = new Float64Array(9);
  const XtY0 = new Float64Array(3);
  const XtY1 = new Float64Array(3);
  const XtY2 = new Float64Array(3);
  const pairs = [];

  for (let y = y0; y < y1; y++) {
    const row = y * ew * 3;
    for (let x = x0; x < x1; x++) {
      const i = row + x * 3;
      const er = embRgb[i], eg = embRgb[i + 1], eb = embRgb[i + 2];
      if (er < loEmb || eg < loEmb || eb < loEmb || er > hiEmb || eg > hiEmb || eb > hiEmb) continue;
      const rr = rawRgb[i], rg = rawRgb[i + 1], rb = rawRgb[i + 2];
      if (rr < 0.005 || rg < 0.005 || rb < 0.005) continue;

      const avgR = (rr + rg + rb) / 3;
      const avgE = (er + eg + eb) / 3;
      const s = avgR / avgE;
      const tr = er * s, tg = eg * s, tb = eb * s;

      XtX[0] += rr * rr; XtX[1] += rr * rg; XtX[2] += rr * rb;
      XtX[3] += rg * rr; XtX[4] += rg * rg; XtX[5] += rg * rb;
      XtX[6] += rb * rr; XtX[7] += rb * rg; XtX[8] += rb * rb;

      XtY0[0] += rr * tr; XtY0[1] += rg * tr; XtY0[2] += rb * tr;
      XtY1[0] += rr * tg; XtY1[1] += rg * tg; XtY1[2] += rb * tg;
      XtY2[0] += rr * tb; XtY2[1] += rg * tb; XtY2[2] += rb * tb;

      pairs.push(rr, rg, rb, tr, tg, tb);
    }
  }

  const count = pairs.length / 6;
  if (count < 200) return null;

  const trace = (XtX[0] + XtX[4] + XtX[8]) / 3;
  const lambda = Math.max(1e-4, trace * 0.04);
  const A = new Float64Array(XtX);
  A[0] += lambda; A[4] += lambda; A[8] += lambda;

  const r0 = solve3x3(A, [XtY0[0] + lambda, XtY0[1], XtY0[2]]);
  const r1 = solve3x3(A, [XtY1[0], XtY1[1] + lambda, XtY1[2]]);
  const r2 = solve3x3(A, [XtY2[0], XtY2[1], XtY2[2] + lambda]);
  if (!r0 || !r1 || !r2) return null;

  const mat = [r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]];

  for (let row = 0; row < 3; row++) {
    const a = mat[row * 3], b = mat[row * 3 + 1], c = mat[row * 3 + 2];
    const sum = a + b + c;
    const diag = mat[row * 3 + row];
    if (!(sum >= 0.80 && sum <= 1.25 && diag >= 0.60 && diag <= 1.65)) return null;
    for (let col = 0; col < 3; col++) {
      if (col !== row && Math.abs(mat[row * 3 + col]) > 0.55) return null;
    }
  }

  let errBefore = 0, errAfter = 0, norm = 0;
  for (let k = 0; k < pairs.length; k += 6) {
    const rr = pairs[k], rg = pairs[k + 1], rb = pairs[k + 2];
    const tr = pairs[k + 3], tg = pairs[k + 4], tb = pairs[k + 5];
    const mr = mat[0] * rr + mat[1] * rg + mat[2] * rb;
    const mg = mat[3] * rr + mat[4] * rg + mat[5] * rb;
    const mb = mat[6] * rr + mat[7] * rg + mat[8] * rb;
    errBefore += (rr - tr) * (rr - tr) + (rg - tg) * (rg - tg) + (rb - tb) * (rb - tb);
    errAfter += (mr - tr) * (mr - tr) + (mg - tg) * (mg - tg) + (mb - tb) * (mb - tb);
    norm += tr * tr + tg * tg + tb * tb;
  }
  const relAfter = norm > 0 ? Math.sqrt(errAfter / norm) : 1;
  if (!(errAfter < errBefore * 0.90 && relAfter < 0.25)) return null;

  return mat;
}

/** 预计算「单通道线性值 x ∈ [0, ∞) -> 机内 Tone Curve -> 8-bit sRGB」有理压缩 LUT（u = x/(x+0.5)） */
const CURVE_LUT_N = 8192;
function buildChannelCurveSrgbLut(curve, hl) {
  const table = new Uint8Array(CURVE_LUT_N + 1);
  for (let i = 0; i <= CURVE_LUT_N; i++) {
    const u = i / CURVE_LUT_N;
    const x = i === CURVE_LUT_N ? 1e6 : (0.5 * u) / (1 - u);
    const yOut = evalCameraToneCurve(curve, x, hl);
    table[i] = LIN_TO_SRGB[yOut <= 0 ? 0 : (yOut >= 1 ? LIN_LUT_SIZE : (yOut * LIN_LUT_SIZE + 0.5) | 0)];
  }
  return table;
}

/**
 * 在 16-bit 线性空间中完成：曝光 -> 3x3 色彩适配矩阵 -> 暗部提亮/高光压暗 -> R/G/B 分通道机内 Tone Curve + sRGB 编码。
 * 使用有理压缩 8192 项分通道 LUT，全正半轴零越界、零 Math.pow/sqrt，600 万像素约 67~117ms。
 * 溢出检测支持两级暗部告警：正蓝=物理硬件死黑（<=12），浅冰蓝=跌进噪底（<=noisePct% 满阱）。
 */
function developLinear16ToRgb8(entry, ev, shadow = 0, highlight = 0, sensorPpm = null, noisePct = 0.3) {
  const { w, h, rgb16, gain, colorMat, curveR, curveG, curveB } = entry;
  const baseScale = (gain || 1) * Math.pow(2, ev);
  const sh = Math.max(0, Math.min(2, shadow || 0));
  const hl = Math.max(0, Math.min(2, highlight || 0));
  const hasShHl = sh > 0.001 || hl > 0.001;

  const lutR = buildChannelCurveSrgbLut(curveR, hl);
  const lutG = buildChannelCurveSrgbLut(curveG, hl);
  const lutB = buildChannelCurveSrgbLut(curveB, hl);

  let shHlLut = null;
  if (hasShHl) {
    const shStops = sh > 0.001 ? 4.35 * (1 - Math.exp(-1.05 * sh)) : 0;
    const shY0 = 0.08 + 0.05 * Math.max(0, sh - 1);
    const hlStops = hl > 0.001 ? 3.60 * (1 - Math.exp(-0.85 * hl)) : 0;
    shHlLut = new Float32Array(CURVE_LUT_N + 1);
    for (let i = 0; i <= CURVE_LUT_N; i++) {
      const u = i / CURVE_LUT_N;
      const y = i === CURVE_LUT_N ? 1e4 : (0.5 * u) / (1 - u);
      let mul = 1;
      if (shStops > 0) {
        const wSh = 1 / (1 + Math.pow(y / shY0, 1.3));
        mul *= Math.pow(2, shStops * wSh);
      }
      if (hlStops > 0) {
        const yAdj = y * mul;
        const yp = Math.pow(yAdj, 1.5);
        const wHl = yp / (yp + 0.164316767);
        mul *= Math.pow(2, -hlStops * wHl);
      }
      shHlLut[i] = mul;
    }
  }

  const out = Buffer.allocUnsafe(w * h * 3);
  const len = w * h * 3;
  const scaleInv = baseScale / 65535;
  const hasMat = !!colorMat;
  const m0 = hasMat ? colorMat[0] : 1, m1 = hasMat ? colorMat[1] : 0, m2 = hasMat ? colorMat[2] : 0;
  const m3 = hasMat ? colorMat[3] : 0, m4 = hasMat ? colorMat[4] : 1, m5 = hasMat ? colorMat[5] : 0;
  const m6 = hasMat ? colorMat[6] : 0, m7 = hasMat ? colorMat[7] : 0, m8 = hasMat ? colorMat[8] : 1;

  for (let i = 0; i < len; i += 3) {
    let r = rgb16[i] * scaleInv;
    let g = rgb16[i + 1] * scaleInv;
    let b = rgb16[i + 2] * scaleInv;

    if (hasMat) {
      const nr = m0 * r + m1 * g + m2 * b;
      const ng = m3 * r + m4 * g + m5 * b;
      const nb = m6 * r + m7 * g + m8 * b;
      r = nr > 0 ? nr : 0;
      g = ng > 0 ? ng : 0;
      b = nb > 0 ? nb : 0;
    }

    if (hasShHl) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mul = shHlLut[(y / (y + 0.5) * CURVE_LUT_N) | 0];
      r *= mul;
      g *= mul;
      b *= mul;
    }

    out[i] = lutR[(r / (r + 0.5) * CURVE_LUT_N) | 0];
    out[i + 1] = lutG[(g / (g + 0.5) * CURVE_LUT_N) | 0];
    out[i + 2] = lutB[(b / (b + 0.5) * CURVE_LUT_N) | 0];
  }

  // 可选叠加：基于物理传感器 16-bit 线性数据标出真溢出（红=高光死白 · 正蓝=硬件死黑 · 浅蓝=跌进噪底）
  if (sensorPpm && sensorPpm.ppm && sensorPpm.buf) {
    const { w: rw, h: rh, offset: baseOff } = sensorPpm.ppm;
    const p = sensorPpm.buf;
    const hiThresh = 64800;
    const loThresh = 12;
    const np = Math.max(0, Math.min(5, Number.isFinite(Number(noisePct)) ? Number(noisePct) : 0.3));
    const noiseThresh = np > 0 ? Math.round((65535 * np) / 100) : 0;
    for (let y = 0; y < h; y++) {
      const sy = Math.floor((y * rh) / h);
      const ppmRow = baseOff + sy * rw * 6;
      const outRow = y * w * 3;
      for (let x = 0; x < w; x++) {
        const sx = Math.floor((x * rw) / w);
        const po = ppmRow + sx * 6;
        const sr = (p[po] << 8) | p[po + 1];
        const sg = (p[po + 2] << 8) | p[po + 3];
        const sb = (p[po + 4] << 8) | p[po + 5];
        const o = outRow + x * 3;
        if (sr >= hiThresh && sg >= hiThresh && sb >= hiThresh) {
          // 🔴 高光硬件饱和死白
          out[o] = 255;
          out[o + 1] = (out[o + 1] / 5) | 0;
          out[o + 2] = (out[o + 2] / 5) | 0;
        } else if (sr <= loThresh && sg <= loThresh && sb <= loThresh) {
          // 🔵 暗部硬件归零死黑（正蓝）
          out[o] = (out[o] / 5) | 0;
          out[o + 1] = Math.min(255, ((out[o + 1] / 4) | 0) + 35);
          out[o + 2] = 255;
        } else if (noiseThresh > loThresh && sr <= noiseThresh && sg <= noiseThresh && sb <= noiseThresh) {
          // 🩵 跌进噪底告警（半透明浅冰蓝，保留底层轮廓同时清晰区分于正蓝死黑）
          out[o] = Math.min(255, ((out[o] * 0.45) | 0) + 64);
          out[o + 1] = Math.min(255, ((out[o + 1] * 0.45) | 0) + 122);
          out[o + 2] = Math.min(255, ((out[o + 2] * 0.45) | 0) + 142);
        }
      }
    }
  }

  return out;
}

/** 创建 RAW 显影服务实例（通过显式依赖注入与 server.js 解耦） */
function createRawDev({
  IS_MAC,
  CACHE_DIR,
  PREV_DIR,
  DCRAW_EMU,
  RAWDEV_SRC,
  RAWDEV_BIN,
  sha1,
  kindOf,
  sharpLib,
  activeChildren,
  gateRawDev,
  getRawBigCache,
  extractEmbeddedJpeg,
  ffmpegScaleBuffer,
  logOp,
}) {
  let rawDevBuildPromise = null;
  async function ensureMacRawDevBin() {
    if (!IS_MAC) return null;
    if (!fs.existsSync(RAWDEV_SRC)) return null;
    try {
      const [srcSt, binSt] = await Promise.all([fsp.stat(RAWDEV_SRC), fsp.stat(RAWDEV_BIN).catch(() => null)]);
      if (binSt && binSt.mtimeMs >= srcSt.mtimeMs) return RAWDEV_BIN;
    } catch { return null; }
    if (rawDevBuildPromise) return rawDevBuildPromise;
    rawDevBuildPromise = (async () => {
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        await new Promise((resolve, reject) => {
          let err = '';
          const p = spawn('swiftc', ['-O', RAWDEV_SRC, '-o', RAWDEV_BIN], { stdio: ['ignore', 'ignore', 'pipe'] });
          p.stderr.on('data', (d) => { err += d.toString(); });
          p.on('error', reject);
          p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200) || `swiftc exit ${code}`))));
        });
        return RAWDEV_BIN;
      } catch (e) {
        console.error('  rawdev.swift 编译失败（将回退 dcraw_emu）:', e.message);
        return null;
      } finally {
        rawDevBuildPromise = null;
      }
    })();
    return rawDevBuildPromise;
  }

  function runRawDevMac(bin, absFile, outFile, ev, maxPx, shadow = 0, highlight = 0, clipPpmPath = '', noisePct = 0.3, timeoutMs = 45000, signal = null) {
    return new Promise((resolve, reject) => {
      let stderr = '';
      const args = [absFile, outFile, String(ev), String(maxPx), String(shadow), String(highlight)];
      if (clipPpmPath) args.push(clipPpmPath, String(noisePct));
      const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      activeChildren.add(p);
      const onAbort = () => { try { p.kill('SIGKILL'); } catch {} reject(new Error('aborted')); };
      if (signal) {
        if (signal.aborted) { try { p.kill('SIGKILL'); } catch {} return reject(new Error('aborted')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('rawdev timeout')); }, timeoutMs);
      const done = () => { clearTimeout(t); activeChildren.delete(p); if (signal) signal.removeEventListener('abort', onAbort); };
      p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-2000); });
      p.on('error', (e) => { done(); reject(e); });
      p.on('close', (code) => {
        done();
        code === 0 ? resolve() : reject(new Error(`rawdev exit ${code}: ${stderr.slice(-200)}`));
      });
    });
  }

  function runDcrawPpmBuffer(args, timeoutMs = 45000, signal = null) {
    return new Promise((resolve, reject) => {
      const p = spawn(DCRAW_EMU, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChildren.add(p);
      const chunks = [];
      let err = '';
      const onAbort = () => { try { p.kill('SIGKILL'); } catch {} reject(new Error('aborted')); };
      if (signal) {
        if (signal.aborted) { try { p.kill('SIGKILL'); } catch {} return reject(new Error('aborted')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('dcraw_emu timeout')); }, timeoutMs);
      const done = () => { clearTimeout(t); activeChildren.delete(p); if (signal) signal.removeEventListener('abort', onAbort); };
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-2000); });
      p.on('error', (e) => { done(); reject(e); });
      p.on('close', (code) => {
        done();
        if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
        else reject(new Error(`dcraw_emu exit ${code}: ${err.slice(-200)}`));
      });
    });
  }

  function dumpSensorPpm16(absFile, outPpm, timeoutMs = 30000, signal = null) {
    return new Promise((resolve, reject) => {
      const args = ['-h', '-4', '-H', '0', '-r', '1', '1', '1', '1', '-o', '0', '-Z', '-', absFile];
      const p = spawn(DCRAW_EMU, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const ws = fs.createWriteStream(outPpm);
      activeChildren.add(p);
      let err = '';
      const cleanup = () => { clearTimeout(t); activeChildren.delete(p); if (signal) signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { try { p.kill('SIGKILL'); } catch {} try { ws.destroy(); } catch {} reject(new Error('aborted')); };
      if (signal) {
        if (signal.aborted) { try { p.kill('SIGKILL'); } catch {} try { ws.destroy(); } catch {} return reject(new Error('aborted')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const t = setTimeout(() => { try { p.kill(); } catch {} try { ws.destroy(); } catch {} reject(new Error('dcraw sensor timeout')); }, timeoutMs);
      p.stdout.pipe(ws);
      p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 2000) err = err.slice(-1000); });
      p.on('error', (e) => { cleanup(); try { ws.destroy(); } catch {} reject(e); });
      ws.on('error', (e) => { cleanup(); try { p.kill('SIGKILL'); } catch {} reject(e); });
      let exitCode = null, wsDone = false;
      const maybeFinish = () => {
        if (exitCode === null || !wsDone) return;
        cleanup();
        if (exitCode === 0) resolve(outPpm);
        else reject(new Error(`dcraw sensor exit ${exitCode}: ${err.slice(-200)}`));
      };
      p.on('close', (code) => { exitCode = code; maybeFinish(); });
      ws.on('finish', () => { wsDone = true; maybeFinish(); });
    });
  }

  /** 优先查找同目录同名机内直出 JPG（如 CR3+JPG 同名组），没有则回退 RAW 内嵌 JPEG */
  async function loadReferenceJpeg(absFile, st) {
    const stem = absFile.slice(0, absFile.length - path.extname(absFile).length);
    for (const ext of ['.JPG', '.jpg', '.JPEG', '.jpeg']) {
      const cand = stem + ext;
      try {
        const cst = await fsp.stat(cand);
        if (cst.isFile() && cst.size > 4096 && cst.size < 40 * 1024 * 1024) {
          return await fsp.readFile(cand);
        }
      } catch {}
    }
    const bigKey = `${absFile}|${st.size}|${Math.round(st.mtimeMs)}`;
    const cached = getRawBigCache(bigKey);
    if (cached) return cached;
    return extractEmbeddedJpeg(absFile, 12 * 1024 * 1024);
  }

  /** 在线性光域联合估算：基准增益 gain + 中心 3x3 色彩适配矩阵 + R/G/B 三通道独立机内 Tone Curve */
  async function estimateLinearProfile(absFile, st, w, h, rgb16) {
    const refBuf = await loadReferenceJpeg(absFile, st);

    if (refBuf && sharpLib) {
      try {
        const { data, info } = await sharpLib(refBuf)
          .rotate()
          .withIccProfile('srgb', { attach: false })
          .toColorspace('srgb')
          .resize(160, 160, { fit: 'inside' })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const ew = info.width, eh = info.height;
        const embLinRgb = new Float32Array(ew * eh * 3);
        for (let i = 0; i < embLinRgb.length; i++) embLinRgb[i] = SRGB_TO_LIN[data[i]];

        const rawLinRgb = new Float32Array(ew * eh * 3);
        const inv65535 = 1 / 65535;
        const sx = w / ew;
        const sy = h / eh;
        for (let y = 0; y < eh; y++) {
          const y0 = Math.min(h - 1, Math.floor(y * sy));
          const y1 = Math.min(h - 1, Math.floor((y + 0.5) * sy));
          for (let x = 0; x < ew; x++) {
            const x0 = Math.min(w - 1, Math.floor(x * sx));
            const x1 = Math.min(w - 1, Math.floor((x + 0.5) * sx));
            const p00 = (y0 * w + x0) * 3;
            const p01 = (y0 * w + x1) * 3;
            const p10 = (y1 * w + x0) * 3;
            const p11 = (y1 * w + x1) * 3;
            const o = (y * ew + x) * 3;
            rawLinRgb[o] = (rgb16[p00] + rgb16[p01] + rgb16[p10] + rgb16[p11]) * 0.25 * inv65535;
            rawLinRgb[o + 1] = (rgb16[p00 + 1] + rgb16[p01 + 1] + rgb16[p10 + 1] + rgb16[p11 + 1]) * 0.25 * inv65535;
            rawLinRgb[o + 2] = (rgb16[p00 + 2] + rgb16[p01 + 2] + rgb16[p10 + 2] + rgb16[p11 + 2]) * 0.25 * inv65535;
          }
        }

        const cx0 = Math.floor(ew * 0.15), cx1 = Math.max(cx0 + 1, Math.floor(ew * 0.85));
        const cy0 = Math.floor(eh * 0.15), cy1 = Math.max(cy0 + 1, Math.floor(eh * 0.85));
        const cLen = (cx1 - cx0) * (cy1 - cy0);
        const embLum = new Float32Array(cLen);
        const rawLum = new Float32Array(cLen);
        let k = 0;
        for (let y = cy0; y < cy1; y++) {
          const row = y * ew * 3;
          for (let x = cx0; x < cx1; x++) {
            const i = row + x * 3;
            embLum[k] = 0.2126 * embLinRgb[i] + 0.7152 * embLinRgb[i + 1] + 0.0722 * embLinRgb[i + 2];
            rawLum[k] = 0.2126 * rawLinRgb[i] + 0.7152 * rawLinRgb[i + 1] + 0.0722 * rawLinRgb[i + 2];
            k++;
          }
        }
        embLum.sort();
        rawLum.sort();

        let gain = 2.5;
        const loCut = SRGB_TO_LIN[12];
        const hiCut = SRGB_TO_LIN[210];
        let loIdx = 0;
        while (loIdx < cLen && embLum[loIdx] < loCut) loIdx++;
        let hiIdx = cLen - 1;
        while (hiIdx > loIdx && embLum[hiIdx] > hiCut) hiIdx--;

        const logRatios = [];
        const addQ = (q) => {
          const eVal = embLum[Math.min(cLen - 1, Math.max(0, Math.round(q * (cLen - 1))))];
          const rVal = rawLum[Math.min(cLen - 1, Math.max(0, Math.round(q * (cLen - 1))))];
          if (eVal > 1e-4 && rVal > 1e-4) logRatios.push(Math.log(eVal / rVal));
        };
        if (hiIdx - loIdx >= cLen * 0.08) {
          for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) addQ((loIdx + f * (hiIdx - loIdx)) / (cLen - 1));
        } else {
          for (const q of [0.25, 0.5, 0.75, 0.85]) addQ(q);
        }
        if (logRatios.length) {
          logRatios.sort((a, b) => a - b);
          gain = Math.min(16, Math.max(0.5, Math.exp(logRatios[Math.floor(logRatios.length / 2)])));
        }

        const rawScaledGrid = new Float32Array(rawLinRgb.length);
        for (let i = 0; i < rawLinRgb.length; i++) rawScaledGrid[i] = rawLinRgb[i] * gain;
        const aspectDiff = Math.abs((w / h) / (ew / eh) - 1);
        const colorMat = aspectDiff < 0.06 ? fitColorMatrix3x3(rawScaledGrid, embLinRgb, ew, eh) : null;

        const embR = new Float32Array(cLen), embG = new Float32Array(cLen), embB = new Float32Array(cLen);
        const rawR = new Float32Array(cLen), rawG = new Float32Array(cLen), rawB = new Float32Array(cLen);
        const rawLumScaled = new Float32Array(cLen);
        k = 0;
        for (let y = cy0; y < cy1; y++) {
          const row = y * ew * 3;
          for (let x = cx0; x < cx1; x++) {
            const i = row + x * 3;
            embR[k] = embLinRgb[i]; embG[k] = embLinRgb[i + 1]; embB[k] = embLinRgb[i + 2];
            let rr = rawScaledGrid[i], rg = rawScaledGrid[i + 1], rb = rawScaledGrid[i + 2];
            if (colorMat) {
              const nr = colorMat[0] * rr + colorMat[1] * rg + colorMat[2] * rb;
              const ng = colorMat[3] * rr + colorMat[4] * rg + colorMat[5] * rb;
              const nb = colorMat[6] * rr + colorMat[7] * rg + colorMat[8] * rb;
              rr = nr > 0 ? nr : 0; rg = ng > 0 ? ng : 0; rb = nb > 0 ? nb : 0;
            }
            rawR[k] = rr; rawG[k] = rg; rawB[k] = rb;
            rawLumScaled[k] = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
            k++;
          }
        }
        embR.sort(); embG.sort(); embB.sort();
        rawR.sort(); rawG.sort(); rawB.sort();
        rawLumScaled.sort();

        const lumCurve = fitCameraToneCurve(embLum, rawLumScaled);
        const curveR = fitCameraToneCurve(embR, rawR) || lumCurve;
        const curveG = fitCameraToneCurve(embG, rawG) || lumCurve;
        const curveB = fitCameraToneCurve(embB, rawB) || lumCurve;

        if (process.env.RAWDEV_DEBUG) {
          console.error(
            `  [profile] gain=${gain.toFixed(2)} colorMat=${colorMat ? colorMat.map((v) => v.toFixed(2)).join(',') : 'none'} ` +
            `curves=${curveR ? curveR.xs.length : 0}/${curveG ? curveG.xs.length : 0}/${curveB ? curveB.xs.length : 0}`
          );
        }
        return { gain, colorMat, curveR, curveG, curveB };
      } catch {}
    }

    const rx0 = Math.floor(w * 0.15), rx1 = Math.max(rx0 + 1, Math.floor(w * 0.85));
    const ry0 = Math.floor(h * 0.15), ry1 = Math.max(ry0 + 1, Math.floor(h * 0.85));
    const stepX = Math.max(1, Math.floor((rx1 - rx0) / 100));
    const stepY = Math.max(1, Math.floor((ry1 - ry0) / 70));
    const rawSamples = [];
    for (let y = ry0; y < ry1; y += stepY) {
      const row = y * w * 3;
      for (let x = rx0; x < rx1; x += stepX) {
        const i = row + x * 3;
        rawSamples.push((0.2126 * rgb16[i] + 0.7152 * rgb16[i + 1] + 0.0722 * rgb16[i + 2]) / 65535);
      }
    }
    const rawLin = Float32Array.from(rawSamples);
    rawLin.sort();
    const rn = rawLin.length;
    let fallbackGain = 2.5;
    if (rn > 16) {
      const p50 = rawLin[Math.floor(rn * 0.5)];
      const p98 = rawLin[Math.floor(rn * 0.98)];
      if (p98 > 1e-3 && p50 > 1e-4) {
        fallbackGain = Math.min(8, Math.max(1, Math.min(0.85 / p98, 0.16 / p50)));
      }
    }
    return { gain: fallbackGain, colorMat: null, curveR: null, curveG: null, curveB: null };
  }

  // 16-bit 线性 RAW 内存小 LRU（同一张图连续切换 +1/+2/+3/暗部/高光时无需重复跑 dcraw_emu）
  const rawLinearCache = new Map();
  const RAW_LINEAR_MAX_ITEMS = 2;
  const RAW_LINEAR_MAX_BYTES = 160 * 1024 * 1024;
  let rawLinearCacheBytes = 0;

  function getRawLinearCache(key) {
    if (!rawLinearCache.has(key)) return null;
    const hit = rawLinearCache.get(key);
    rawLinearCache.delete(key);
    rawLinearCache.set(key, hit);
    return hit;
  }
  function setRawLinearCache(key, entry) {
    const bytes = entry.rgb16.byteLength;
    if (bytes > RAW_LINEAR_MAX_BYTES) return;
    if (rawLinearCache.has(key)) {
      rawLinearCacheBytes -= rawLinearCache.get(key).rgb16.byteLength;
      rawLinearCache.delete(key);
    }
    rawLinearCache.set(key, entry);
    rawLinearCacheBytes += bytes;
    while (rawLinearCache.size > RAW_LINEAR_MAX_ITEMS || rawLinearCacheBytes > RAW_LINEAR_MAX_BYTES) {
      const oldest = rawLinearCache.keys().next().value;
      rawLinearCacheBytes -= rawLinearCache.get(oldest).rgb16.byteLength;
      rawLinearCache.delete(oldest);
    }
  }
  function clearRawLinearCache() {
    rawLinearCache.clear();
    rawLinearCacheBytes = 0;
  }
  function invalidateRawLinearFile(absFile) {
    for (const k of rawLinearCache.keys()) {
      if (k.startsWith(absFile + '|')) {
        rawLinearCacheBytes -= rawLinearCache.get(k).rgb16.byteLength;
        rawLinearCache.delete(k);
      }
    }
  }

  async function decodeRawLinear16(absFile, st, signal = null) {
    const key = `${absFile}|${st.size}|${Math.round(st.mtimeMs)}`;
    const cached = getRawLinearCache(key);
    if (cached) return cached;

    const ppmBuf = await runDcrawPpmBuffer(
      ['-h', '-w', '-W', '-H', '2', '-o', '1', '-6', '-g', '1', '1', '-Z', '-', absFile],
      45000,
      signal,
    );
    const ppm = parsePpm16(ppmBuf);
    if (!ppm) throw new Error('invalid 16-bit PPM from dcraw_emu');

    const count = ppm.w * ppm.h * 3;
    const rgb16 = new Uint16Array(count);
    let off = ppm.offset;
    for (let i = 0; i < count; i++, off += 2) {
      rgb16[i] = (ppmBuf[off] << 8) | ppmBuf[off + 1];
    }

    const profile = await estimateLinearProfile(absFile, st, ppm.w, ppm.h, rgb16);
    const entry = {
      w: ppm.w,
      h: ppm.h,
      rgb16,
      gain: profile.gain,
      colorMat: profile.colorMat,
      curveR: profile.curveR,
      curveG: profile.curveG,
      curveB: profile.curveB,
    };
    setRawLinearCache(key, entry);
    return entry;
  }

  const rawDevJobs = new Map();
  /** RAW 曝光补偿 / 暗部提亮 / 高光压暗 / 两级线性溢出检测预览（ev: -4~+4, sh: 0~2, hl: 0~2, clip: 0|1, noisePct: 0~5） */
  async function makeRawDevPreview(absFile, rel, evRaw, shRaw = 0, hlRaw = 0, clipRaw = false, maxRaw = 2048, signal = null, noisePctRaw = 0.3) {
    if (kindOf(absFile) !== 'raw') return null;
    let st;
    try { st = await fsp.stat(absFile); } catch { return null; }
    const ev = Math.max(-4, Math.min(4, Math.round(Number(evRaw) * 2) / 2 || 0));
    const sh = Math.max(0, Math.min(2, Math.round(Number(shRaw) * 20) / 20 || 0));
    const hl = Math.max(0, Math.min(2, Math.round(Number(hlRaw) * 20) / 20 || 0));
    const clip = clipRaw === true || clipRaw === '1' || clipRaw === 1;
    const npNum = Number(noisePctRaw);
    const noisePct = Math.max(0, Math.min(5, Math.round((Number.isFinite(npNum) ? npNum : 0.1) * 1000) / 1000));
    const rawMaxNum = Number(maxRaw);
    const BIG_MAX = rawMaxNum === 0 ? 0 : Math.max(1024, Math.min(8192, Math.round(rawMaxNum || 2048)));
    const clipTag = clip ? `c1_np${noisePct}` : 'c0';
    const key = sha1(`${rel}|${st.size}|${Math.round(st.mtimeMs)}|rawdev_v16|m${BIG_MAX}|ev${ev}|sh${sh}|hl${hl}|${clipTag}`);
    const out = path.join(PREV_DIR, `${key}-ev.jpg`);

    try { await fsp.access(out); return { file: out, mime: 'image/jpeg' }; } catch {}
    if (rawDevJobs.has(key)) return rawDevJobs.get(key);

    const job = (async () => {
      await fsp.mkdir(PREV_DIR, { recursive: true });
      const tmp = out.replace(/\.jpg$/, '.part.jpg');

      // 方案 B：macOS 原生 CIRAWFilter + CIHighlightShadowAdjust + 物理传感器 16-bit 溢出检测
      if (IS_MAC) {
        const bin = await ensureMacRawDevBin();
        if (bin) {
          const tmpPpm = clip ? out.replace(/\.jpg$/, '.part.ppm') : '';
          try {
            await gateRawDev(async () => {
              if (tmpPpm) await dumpSensorPpm16(absFile, tmpPpm, 30000, signal);
              await runRawDevMac(bin, absFile, tmp, ev, BIG_MAX, sh, hl, tmpPpm, noisePct, 45000, signal);
            }, signal);
            await fsp.rename(tmp, out);
            return { file: out, mime: 'image/jpeg' };
          } catch (e) {
            try { await fsp.unlink(tmp); } catch {}
            if (signal && signal.aborted) throw e;
          } finally {
            if (tmpPpm) try { await fsp.unlink(tmpPpm); } catch {}
          }
        }
      }

      // 方案 A 兜底：dcraw_emu（LibRaw）单次 16-bit 线性解码 -> 线性显影 -> JPEG
      try {
        const data = await gateRawDev(async () => {
          const entry = await decodeRawLinear16(absFile, st, signal);
          if (signal && signal.aborted) throw new Error('aborted');
          let sensorPpm = null;
          if (clip) {
            try {
              const sBuf = await runDcrawPpmBuffer(['-h', '-4', '-H', '0', '-r', '1', '1', '1', '1', '-o', '0', '-Z', '-', absFile], 30000, signal);
              const sPpm = parsePpm16(sBuf);
              if (sPpm) sensorPpm = { ppm: sPpm, buf: sBuf };
            } catch (e) {
              if (signal && signal.aborted) throw e;
            }
          }
          const rgb8 = developLinear16ToRgb8(entry, ev, sh, hl, sensorPpm, noisePct);
          const fallbackMax = BIG_MAX || 4096;
          if (sharpLib) {
            try {
              return await sharpLib(rgb8, { raw: { width: entry.w, height: entry.h, channels: 3 } })
                .resize({ width: fallbackMax, height: fallbackMax, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: clip ? 90 : 86 })
                .toBuffer();
            } catch {}
          }
          const ppmHeader = Buffer.from(`P6\n${entry.w} ${entry.h}\n255\n`, 'ascii');
          return ffmpegScaleBuffer(Buffer.concat([ppmHeader, rgb8]), fallbackMax, signal);
        }, signal);
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, out);
        return { file: out, mime: 'image/jpeg' };
      } catch (e) {
        try { await fsp.unlink(tmp); } catch {}
        if (signal && signal.aborted) throw e;
        if (logOp) logOp('RAW失败', `${rel} (ev=${ev} sh=${sh} hl=${hl}) -> ${String((e && e.message) || e)}`, true);
        return null;
      }
    })().finally(() => rawDevJobs.delete(key));

    rawDevJobs.set(key, job);
    return job;
  }

  return { makeRawDevPreview, clearRawLinearCache, invalidateRawLinearFile, estimateLinearProfile };
}

module.exports = {
  createRawDev,
  SRGB_TO_LIN,
  LIN_TO_SRGB,
  parsePpm16,
  fitCameraToneCurve,
  evalCameraToneCurve,
  fitColorMatrix3x3,
  developLinear16ToRgb8,
};
