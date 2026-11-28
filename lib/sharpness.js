/**
 * 原生 1:1 像素级清晰度分析 + 轻量离线 YuNet 人脸/眼部检测
 *
 * 模型信息：
 *   models/face_detection_yunet_2023mar.onnx（OpenCV Zoo YuNet，MIT 开源协议，约 227 KB）
 *   运行时：onnxruntime-node（optionalDependencies，未安装时自动回退为全图 1:1 清晰度）
 *
 * 核心原理：
 *   1) 人像优先：在 640px 缩图上用 YuNet 检出人脸框与双眼关键点（约 25–35 ms），
 *      直接对 1:1 原生眼带区域测各向同性边缘宽度 iso = (p15X + p15Y) / 2，
 *      防止纵向刘海/遮阳伞杆/背景泳池扶梯抢占高分；若背景清晰而人脸偏虚则标注「疑似跑焦」。
 *   2) 无人脸场景：沿用横图 8×6 / 竖图 6×8 原生 1:1 块对比度无关边缘宽度（C / m）+
 *      平滑方向性手抖扣分 + Immerkaer 噪声抑制。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SHARP_CACHE_MAX = 500;
const YUNET_MODEL_PATH = path.join(__dirname, '..', 'models', 'face_detection_yunet_2023mar.onnx');

let ortLib = null;
try { ortLib = require('onnxruntime-node'); } catch {}

let yunetSessionPromise = null;
function getYunetSession() {
  if (!ortLib) return Promise.resolve(null);
  if (!fs.existsSync(YUNET_MODEL_PATH)) return Promise.resolve(null);
  if (!yunetSessionPromise) {
    yunetSessionPromise = ortLib.InferenceSession.create(YUNET_MODEL_PATH, {
      executionProviders: ['cpu'],
      logSeverityLevel: 3,
    }).catch(() => null);
  }
  return yunetSessionPromise;
}

function nmsBoxes(dets, iouThresh = 0.35) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) {
    let ok = true;
    for (const k of keep) {
      const ix1 = Math.max(d.x, k.x), iy1 = Math.max(d.y, k.y);
      const ix2 = Math.min(d.x + d.w, k.x + k.w), iy2 = Math.min(d.y + d.h, k.y + k.h);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const union = d.w * d.h + k.w * k.h - inter;
      if (union > 0 && inter / union > iouThresh) { ok = false; break; }
    }
    if (ok) keep.push(d);
  }
  return keep;
}

async function detectFaces(srcBuf, sharpLib, scoreThresh = 0.60) {
  const session = await getYunetSession();
  if (!session || !sharpLib) return [];
  const { data, info } = await sharpLib(srcBuf)
    .rotate()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const iw = info.width, ih = info.height;
  const padW = 640, padH = 640, plane = padW * padH;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const s = (y * iw + x) * 3;
      const d = y * padW + x;
      input[d] = data[s + 2];             // B
      input[plane + d] = data[s + 1];     // G
      input[2 * plane + d] = data[s];     // R
    }
  }
  const tensor = new ortLib.Tensor('float32', input, [1, 3, padH, padW]);
  const out = await session.run({ [session.inputNames[0]]: tensor });

  const dets = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`].data;
    const obj = out[`obj_${stride}`].data;
    const bbox = out[`bbox_${stride}`].data;
    const kps = out[`kps_${stride}`].data;
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const sc = Math.sqrt(Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])));
        if (sc < scoreThresh) continue;
        const cx = (c + bbox[i * 4]) * stride;
        const cy = (r + bbox[i * 4 + 1]) * stride;
        const bw = Math.exp(bbox[i * 4 + 2]) * stride;
        const bh = Math.exp(bbox[i * 4 + 3]) * stride;
        const x = Math.max(0, cx - bw / 2);
        const y = Math.max(0, cy - bh / 2);
        dets.push({
          score: sc,
          x: Math.max(0, Math.min(1, x / iw)),
          y: Math.max(0, Math.min(1, y / ih)),
          w: Math.max(0.005, Math.min(1, bw / iw)),
          h: Math.max(0.005, Math.min(1, bh / ih)),
          re: { x: ((c + kps[i * 10]) * stride) / iw, y: ((r + kps[i * 10 + 1]) * stride) / ih },
          le: { x: ((c + kps[i * 10 + 2]) * stride) / iw, y: ((r + kps[i * 10 + 3]) * stride) / ih },
        });
      }
    }
  }
  return nmsBoxes(dets);
}

/**
 * 通用灰度块边缘宽度测量（支持全图块 step=2 与眼带高密采样 step=1）
 */
function measureGrayPatch(gray, w, h, opts = {}) {
  const step = opts.step || 2;
  const border = opts.border || 14;
  const pct = opts.pct || 0.25;
  const axisRatio = opts.axisRatio || 1.7;
  const minAxisCnt = opts.minAxisCnt || 8;

  const n = w * h;
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

  const gxArr = new Float32Array(n);
  const gyArr = new Float32Array(n);
  const mag = new Float32Array(n);
  for (let y = 2; y < h - 2; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 2; x < w - 2; x++) {
      const idx = r1 + x;
      const gx = (-sm[r0 + x - 1] + sm[r0 + x + 1] - 2 * sm[r1 + x - 1] + 2 * sm[r1 + x + 1] - sm[r2 + x - 1] + sm[r2 + x + 1]) * 0.25;
      const gy = (-sm[r0 + x - 1] - 2 * sm[r0 + x] - sm[r0 + x + 1] + sm[r2 + x - 1] + 2 * sm[r2 + x] + sm[r2 + x + 1]) * 0.25;
      gxArr[idx] = gx;
      gyArr[idx] = gy;
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

  for (let y = border; y < h - border; y += step) {
    for (let x = border; x < w - border; x += step) {
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
      if (agx > agy * axisRatio) wx.push(ew);
      else if (agy > agx * axisRatio) wy.push(ew);
    }
  }

  if (widths.length < 12) return null;
  widths.sort((a, b) => a - b);
  wx.sort((a, b) => a - b);
  wy.sort((a, b) => a - b);
  const p25 = widths[Math.floor(widths.length * pct)];
  const p25X = wx.length >= minAxisCnt ? wx[Math.floor(wx.length * pct)] : 0;
  const p25Y = wy.length >= minAxisCnt ? wy[Math.floor(wy.length * pct)] : 0;
  return { cnt: widths.length, p25, p25X, p25Y, noiseSigma };
}

function measureEyeBand(gray, W, H, face) {
  const rex = face.re.x * W, rey = face.re.y * H;
  const lex = face.le.x * W, ley = face.le.y * H;
  const fw = face.w * W;
  const eyeDist = Math.max(fw * 0.35, Math.hypot(lex - rex, ley - rey));
  const cx = (rex + lex) * 0.5;
  const cy = (rey + ley) * 0.5;
  // 紧贴双眼的窄条区域（宽 = 2.0 × 眼距，高 = 0.78 × 眼距），排除额头大面积纵向刘海干扰
  let bw = Math.max(88, Math.min(560, Math.round(eyeDist * 2.0)));
  let bh = Math.max(64, Math.min(260, Math.round(eyeDist * 0.78)));
  let bx = Math.max(0, Math.min(W - bw, Math.round(cx - bw / 2)));
  let by = Math.max(0, Math.min(H - bh, Math.round(cy - bh * 0.45)));
  bw = Math.min(bw, W - bx);
  bh = Math.min(bh, H - by);
  if (bw < 32 || bh < 32) return null;

  const patch = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    patch.set(gray.subarray((by + y) * W + bx, (by + y) * W + bx + bw), y * bw);
  }
  const m = measureGrayPatch(patch, bw, bh, { step: 1, border: 6, pct: 0.15, axisRatio: 1.4, minAxisCnt: 6 });
  if (!m) return null;
  const px = m.p25X || m.p25;
  const py = m.p25Y || m.p25;
  // 各向同性眼部锐度：横纵均值，纵向刘海无法掩盖纵向拖影（如 _MG_0254 的 7.26px 竖拖影）
  const iso = 0.5 * px + 0.5 * py;
  const score = Math.round(Math.max(1, Math.min(99, 100 / (1 + Math.exp((iso - 2.55) * 1.8)))));
  const worst = Math.max(px, py), best = Math.min(px, py);
  let motionSuspected = false, motionDir = '';
  if (worst >= 4.2 && worst / Math.max(0.8, best) >= 1.75) {
    motionSuspected = true;
    motionDir = px > py ? '横向' : '纵向';
  }
  return {
    score,
    grade: score >= 65 ? '清晰' : (score >= 42 ? '一般' : '疑似糊片'),
    iso: Math.round(iso * 100) / 100,
    px: Math.round(px * 100) / 100,
    py: Math.round(py * 100) / 100,
    noiseSigma: Math.round(m.noiseSigma * 10) / 10,
    motionSuspected,
    motionDir,
  };
}

function widthToScore(ew) {
  return Math.round(Math.max(1, Math.min(99, 100 / (1 + Math.exp((ew - 1.90) * 3.2)))));
}

/**
 * 扫描整张 1:1 灰度缓冲（W × H），返回全图清晰度评分与空间合焦宽度图（横图 8×6 / 竖图 6×8）
 */
function analyzeGrayBuffer(data, W, H, t0) {
  const cols = W >= H ? 8 : 6;
  const rows = W >= H ? 6 : 8;
  const pw = Math.min(240, Math.max(48, Math.floor(W / cols)));
  const ph = Math.min(240, Math.max(48, Math.floor(H / rows)));
  const tileWidths = new Array(cols * rows).fill(9.9);
  const tiles = [];
  const patch = new Uint8Array(pw * ph);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.min(W - pw, Math.floor((c + 0.5) * (W / cols) - pw / 2)));
      const y0 = Math.max(0, Math.min(H - ph, Math.floor((r + 0.5) * (H / rows) - ph / 2)));
      for (let y = 0; y < ph; y++) {
        const srcOff = (y0 + y) * W + x0;
        patch.set(data.subarray(srcOff, srcOff + pw), y * pw);
      }
      const m = measureGrayPatch(patch, pw, ph);
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
    // 平滑方向性手抖惩罚（去掉硬断崖）：随拖影轴宽与横纵比连续过渡
    if ((bestW >= 1.48 && worstAxis >= 2.70 && ratio >= 1.45 && diff >= 0.85) || (worstAxis >= 3.50 && ratio >= 2.00)) {
      motionSuspected = true;
      motionDir = avgX > avgY ? '横向' : '纵向';
      const severity = Math.min(1, Math.max(0.65, ((ratio - 1.35) / 0.60) * 0.6 + ((worstAxis - 2.4) / 1.1) * 0.4));
      effectiveW = bestW + (worstAxis - bestW) * (0.78 * severity);
      const minFloorW = Math.round(effectiveW * 0.85 * 100) / 100;
      for (let i = 0; i < tileWidths.length; i++) {
        if (tileWidths[i] < minFloorW) tileWidths[i] = minFloorW;
      }
    }
  }

  const score = widthToScore(effectiveW);
  const grade = score >= 65 ? '清晰' : (score >= 42 ? '一般' : '疑似糊片');
  const sharpTiles = tileWidths.filter((w) => w <= 1.82).length;

  return {
    dims: `${W}×${H}`,
    mode: 'frame',
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
    src: '1:1 原生像素',
    ms: Math.round(performance.now() - t0),
  };
}

function createSharpnessService({ sharpLib, kindOf, extractEmbeddedJpeg }) {
  const cache = new Map();

  async function analyzeFile(abs) {
    if (!sharpLib) return null;
    const kind = kindOf(abs);
    if (kind === 'video' || kind === 'other') return null;

    let st;
    try { st = await fsp.stat(abs); } catch { return null; }
    const key = `${abs}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }

    const t0 = performance.now();
    let srcBuf = null;
    if (kind === 'raw') {
      srcBuf = await extractEmbeddedJpeg(abs, 12 * 1024 * 1024);
      if (!srcBuf) return null;
    } else {
      srcBuf = await fsp.readFile(abs);
    }

    // 并行：1) 解码 1:1 灰度缓冲  2) YuNet 640px 轻量人脸与双眼检测
    const [grayRes, faces] = await Promise.all([
      sharpLib(srcBuf).rotate().greyscale().raw().toBuffer({ resolveWithObject: true }),
      detectFaces(srcBuf, sharpLib).catch(() => []),
    ]);
    const { data, info } = grayRes;
    const frameRes = analyzeGrayBuffer(data, info.width, info.height, t0);

    let result = frameRes;
    if (faces.length) {
      // 按“面积 × 置信度”挑出主体人脸（若合影有两张大小相近的脸，取其中更清晰的一张）
      faces.sort((a, b) => (b.w * b.h * b.score) - (a.w * a.h * a.score));
      const mainArea = faces[0].w * faces[0].h;
      const candidates = faces.filter((f, idx) => idx === 0 || (idx < 3 && f.w * f.h >= mainArea * 0.45));
      let bestFaceEval = null;
      let bestFaceObj = null;
      for (const f of candidates) {
        const ev = measureEyeBand(data, info.width, info.height, f);
        if (ev && (!bestFaceEval || ev.score > bestFaceEval.score)) {
          bestFaceEval = ev;
          bestFaceObj = f;
        }
      }
      if (bestFaceEval && bestFaceObj) {
        const backFocus = bestFaceEval.score < 55 && frameRes.score >= 65 && (frameRes.score - bestFaceEval.score) >= 22;
        const inheritMotion = !bestFaceEval.motionSuspected && bestFaceEval.score < 55 && frameRes.motionSuspected;
        const finalScore = inheritMotion ? Math.min(bestFaceEval.score, frameRes.score) : bestFaceEval.score;
        const finalGrade = finalScore >= 65 ? '清晰' : (finalScore >= 42 ? '一般' : '疑似糊片');
        result = {
          ...frameRes,
          mode: 'face',
          score: finalScore,
          grade: finalGrade,
          bestW: bestFaceEval.iso,
          noiseSigma: bestFaceEval.noiseSigma,
          motionSuspected: bestFaceEval.motionSuspected || inheritMotion,
          motionDir: bestFaceEval.motionSuspected ? bestFaceEval.motionDir : (inheritMotion ? frameRes.motionDir : ''),
          bgScore: frameRes.score,
          backFocus,
          faceCount: faces.length,
          faceBox: {
            x: Math.round(bestFaceObj.x * 1000) / 1000,
            y: Math.round(bestFaceObj.y * 1000) / 1000,
            w: Math.round(bestFaceObj.w * 1000) / 1000,
            h: Math.round(bestFaceObj.h * 1000) / 1000,
          },
          src: '1:1 人脸眼部',
          ms: Math.round(performance.now() - t0),
        };
      }
    }

    cache.set(key, result);
    if (cache.size > SHARP_CACHE_MAX) cache.delete(cache.keys().next().value);
    return result;
  }

  function invalidateFile(abs) {
    for (const k of cache.keys()) {
      if (k.startsWith(abs + '|')) cache.delete(k);
    }
  }

  return { analyzeFile, invalidateFile };
}

module.exports = { createSharpnessService, analyzeGrayBuffer, measureGrayPatch, measureEyeBand };
