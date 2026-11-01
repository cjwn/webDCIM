#!/usr/bin/env node
/**
 * 照片库总览 —— 本地服务器（零依赖）
 *
 *  启动: node server.js   然后浏览器打开 http://localhost:7788
 *
 * 设计要点：
 *  - 用 Node 原生 fs 并行扫描（比 git-bash 的 du/find 快 30 倍左右）
 *  - 后台扫描，前端轮询 /api/state 边扫边显示，文件夹一个接一个蹦出来
 *  - RAW 缩略图 = 直接抽取文件内嵌的 JPEG 预览（毫秒级，无需解码 RAW）
 *  - 结果缓存到 cache/index.json，二次打开秒开
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- 配置
const ROOT = path.resolve(process.env.OUTPUT_ROOT || 'E:/OUTPUT');
const PORT = Number(process.env.PORT || 7788);
// 默认监听所有网卡：本机用 localhost，局域网用 192.168.x.x 都能访问
// （只想本机可用就启动前 set HOST=127.0.0.1）
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_DIR = path.join(__dirname, 'cache');
const PREV_DIR = path.join(CACHE_DIR, 'prev');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const CACHE_VERSION = 3;
const PREV_VERSION = 'v4';   // 缩略图算法版本，改了就重新生成
const THUMB_MAX = 640;       // 缩略图最长边（px）
const PREV_CAP_BYTES = Number(process.env.PREV_CAP_MB || 2048) * 1024 * 1024;  // 缩略图缓存上限，默认 2 GiB
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif']);
const RAW_EXT = new Set(['.rw2', '.cr3', '.cr2', '.arw', '.orf', '.nef', '.dng', '.raf', '.rwl', '.pef', '.srw', '.raw']);
const HEIF_EXT = new Set(['.hif', '.heic', '.heif', '.h265']);
const VIDEO_EXT = new Set(['.mov', '.mp4', '.avi', '.m4v', '.mkv', '.mts', '.m2ts', '.3gp', '.wmv']);
const IGNORE_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.hif': 'image/heic', '.heic': 'image/heic', '.heif': 'image/heif',
};

const extOf = (p) => path.extname(p).toLowerCase();
const kindOf = (p) => {
  const e = extOf(p);
  if (RAW_EXT.has(e)) return 'raw';
  if (IMAGE_EXT.has(e)) return 'jpg';
  if (HEIF_EXT.has(e)) return 'heif';
  if (VIDEO_EXT.has(e)) return 'video';
  return 'other';
};
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** 列出可供局域网访问的地址（排掉 VMware/Hyper-V 这类虚拟网卡） */
function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vmware|virtualbox|vethernet|loopback|wsl|tap|tun|hamachi|zerotier/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 状态
const state = {
  root: ROOT,
  status: 'idle',        // idle | scanning | ready | error
  fromCache: false,
  startedAt: 0,
  finishedAt: 0,
  elapsedMs: 0,
  progress: { done: 0, total: 0, current: '', bytes: 0 },
  folders: [],           // 扫描结果（边扫边追加）
  errors: [],
  error: null,
};

function totals() {
  const t = { folders: state.folders.length, files: 0, bytes: 0, exts: {}, kinds: {} };
  for (const f of state.folders) {
    t.files += f.files;
    t.bytes += f.bytes;
    for (const [k, v] of Object.entries(f.exts)) {
      const e = (t.exts[k] ||= { n: 0, b: 0 });
      e.n += v.n; e.b += v.b;
    }
    for (const [k, v] of Object.entries(f.kinds)) {
      t.kinds[k] = (t.kinds[k] || 0) + v.n;
    }
  }
  return t;
}

// ---------------------------------------------------------------- EXIF（精简版）
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parseTiff(buf, base) {
  const bo = buf.toString('latin1', base, base + 2);
  if (bo !== 'II' && bo !== 'MM') return null;
  const le = bo === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  // 标准 TIFF 是 42；ORF/RW2 等厂商变体另有 magic（如 'RO'），不强校验
  const magic = u16(base + 2);
  const ifd0Off = u32(base + 4);
  if (!(magic === 42 || magic === 0x4f52 || magic === 0x0052 || magic === 0x0055 || magic === 0x4e52)) return null;
  if (ifd0Off < 8 || base + ifd0Off >= buf.length) return null;

  const out = {};
  const readIfd = (off) => {
    if (!off || off + 2 > buf.length) return;
    const n = Math.min(u16(off), 400);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > buf.length) return;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const size = TYPE_SIZE[type];
      if (!size) continue;
      const total = size * cnt;
      let vo = total <= 4 ? e + 8 : base + u32(e + 8);
      if (vo + total > buf.length) continue;
      const val = () => {
        if (type === 2) {
          let s = buf.toString('latin1', vo, vo + total);
          return s.replace(/\0.*$/s, '').trim();
        }
        if (type === 3) return u16(vo);
        if (type === 4) return u32(vo);
        if (type === 5) { const d = u32(vo + 4); return d ? u32(vo) / d : 0; }
        if (type === 10) { const d = (le ? buf.readInt32LE(vo + 4) : buf.readInt32BE(vo + 4)); return d ? (le ? buf.readInt32LE(vo) : buf.readInt32BE(vo)) / d : 0; }
        return null;
      };
      switch (tag) {
        case 0x010F: out.make = val(); break;
        case 0x0110: out.model = val(); break;
        case 0x0112: out.orientation = val(); break;
        case 0x8769: {
          const p = u32(vo);
          if (p) readIfd(base + p);
          break;
        }
        case 0x9003: out.date = val(); break;
        case 0x829A: out.shutter = val(); break;
        case 0x829D: out.fnumber = val(); break;
        case 0x8827: out.iso = val(); break;
        case 0x920A: out.focal = val(); break;
        case 0xA434: out.lens = val(); break;
        case 0xA002: out.w = val(); break;
        case 0xA003: out.h = val(); break;
      }
    }
  };
  readIfd(base + ifd0Off);
  return out.make || out.model || out.date ? out : null;
}

function exifFromBuffer(buf) {
  const found = [];
  // 常见情况：JPEG APP1 的 "Exif\0\0" 后面就是 TIFF 头
  const idx = buf.indexOf('Exif\0\0', 0, 'latin1');
  if (idx >= 0) {
    try { const e = parseTiff(buf, idx + 6); if (e) found.push(e); } catch {}
  }
  // 兜底：扫所有 TIFF 头（CR3 的 CMT1/CMT2、ORF 的 IIRO、HEIF 的 Exif item…）后合并
  for (let i = 0; i < buf.length - 8; i++) {
    if (!((buf[i] === 0x49 && buf[i + 1] === 0x49) || (buf[i] === 0x4d && buf[i + 1] === 0x4d))) continue;
    try { const e = parseTiff(buf, i); if (e) found.push(e); } catch {}
    if (found.length > 8) break;
  }
  if (!found.length) return null;
  // 字段多的优先，补全缺失字段
  const merged = {};
  for (const e of found.sort((a, b) => Object.keys(b).length - Object.keys(a).length)) {
    for (const [k, v] of Object.entries(e)) {
      if (merged[k] === undefined && v !== undefined && v !== '') merged[k] = v;
    }
  }
  return merged;
}

function prettyExif(e) {
  if (!e) return null;
  const o = {};
  const model = [e.make, e.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (model) o.camera = model;
  if (e.lens) o.lens = e.lens;
  if (e.date) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(e.date);
    o.date = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : e.date;
  }
  if (e.fnumber) o.f = `f/${(+e.fnumber).toFixed(1).replace(/\.0$/, '')}`;
  if (e.shutter) o.shutter = e.shutter >= 1 ? `${(+e.shutter).toFixed(1)}s` : `1/${Math.round(1 / e.shutter)}s`;
  if (e.iso) o.iso = `ISO ${e.iso}`;
  if (e.focal) o.focal = `${(+e.focal).toFixed(0)}mm`;
  if (e.w && e.h) o.dims = `${e.w}×${e.h}`;
  return Object.keys(o).length ? o : null;
}

// ---------------------------------------------------------------- 内嵌 JPEG 预览抽取
const JPEG_SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
const JPEG_EOI = Buffer.from([0xFF, 0xD9]);

function extractEmbeddedJpeg(file, headBytes = 3 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, headBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    // 用 Buffer.indexOf（V8 的 SIMD memchr）替逐字节扫描，快 5~10 倍
    let best = null, from = 0;
    for (;;) {
      const start = buf.indexOf(JPEG_SOI, from);
      if (start < 0) break;
      const end = buf.indexOf(JPEG_EOI, start + 3);
      if (end < 0) break;                      // 预览被截断（文件头不够长）
      const size = end + 2 - start;
      if (size > 3000 && (!best || size > best.size)) best = { start, size };
      from = start + 3;
    }
    return best ? Buffer.from(buf.subarray(best.start, best.start + best.size)) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// 简单并发闸门（支持 AbortSignal：客户端走开后排队中的任务直接丢弃）
function limiter(max) {
  let active = 0; const q = [];
  const next = () => {
    while (active < max && q.length) {
      const job = q.shift();
      if (job.signal && job.signal.aborted) { job.rej(new Error('aborted')); continue; }
      active++;
      job.fn().then(job.res, job.rej).finally(() => { active--; next(); });
    }
  };
  return (fn, signal) => new Promise((res, rej) => {
    const job = { fn, res, rej, signal };
    if (signal) {
      signal.addEventListener('abort', () => {
        const i = q.indexOf(job);
        if (i >= 0) { q.splice(i, 1); rej(new Error('aborted')); }   // 还在排队→直接丢掉
      }, { once: true });
    }
    q.push(job);
    next();
  });
}
const CORES = Math.max(1, (os.cpus() || []).length);
// 并发按核数自适应：8 线程 → 小图 4 / 大图 2；2 线程(N4000 之类) → 2 / 1
const LIGHT_N = Math.max(2, Math.min(4, Math.round(CORES / 2)));
const HEAVY_N = Math.max(1, Math.min(2, Math.round(CORES / 4)));
const ffmpegGate = limiter(3);
const gateLight = limiter(LIGHT_N);
const gateHeavy = limiter(HEAVY_N);
const gateVideo = limiter(1);   // 视频抽帧最贵，一次只跑一个
const gateFor = (size) => (size > 20 * 1024 * 1024 ? gateHeavy : gateLight);

// sharp(libvips) 可选：装了就用它缩图（不起子进程、快 3~5 倍、内存低），没装回退 ffmpeg
let sharpLib = null;
try {
  sharpLib = require('sharp');
  sharpLib.concurrency(Math.max(1, Math.round(CORES / 2)));
  sharpLib.cache({ memory: 64 });
} catch { sharpLib = null; }

async function sharpThumb(input, maxPx) {
  return sharpLib(input)
    .rotate()                                   // 按 EXIF 方向摆正（ffmpeg 对 JPEG 不做这个）
    .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

// ---- 缩略图生成“暂停”开关：播放视频时前端会调，避免抢 CPU/GPU 导致卡顿
// TTL 很短（30s）：即使前端没发 resume（关标签页/刷新/崩溃），最多 30 秒自动恢复。
// 前端在播视频时每 10s 发一次心跳续期。
let previewPaused = false;
let pauseTimer = null;
const activeChildren = new Set();

function pausePreviews(seconds = 30) {
  previewPaused = true;
  for (const p of activeChildren) { try { p.kill('SIGKILL'); } catch {} }
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(resumePreviews, Math.max(5, Math.min(seconds, 600)) * 1000);
}
function resumePreviews() {
  previewPaused = false;
  clearTimeout(pauseTimer);
  pauseTimer = null;
}

function runFfmpeg(args, timeoutMs = 30000, signal = null) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    // stdin/stdout 必须隔离：ffmpeg 若继承控制台会把终端切到鼠标输入模式（鼠标一动就吐乱码）
    const p = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    activeChildren.add(p);
    const onAbort = () => { try { p.kill('SIGKILL'); } catch {} reject(new Error('aborted')); };
    if (signal) {
      if (signal.aborted) { try { p.kill('SIGKILL'); } catch {} return reject(new Error('aborted')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('ffmpeg timeout')); }, timeoutMs);
    const done = () => { clearTimeout(t); activeChildren.delete(p); if (signal) signal.removeEventListener('abort', onAbort); };
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    p.on('error', (e) => { done(); reject(e); });
    p.on('close', (code) => {
      done();
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** 把内存里的图片（或文件）缩到 maxPx 以内，返回 JPEG buffer */
function ffmpegScaleBuffer(input, maxPx, signal = null) {
  return new Promise((resolve, reject) => {
    const isPath = typeof input === 'string';
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (isPath) args.push('-i', input);
    else args.push('-f', 'image2pipe', '-i', 'pipe:0');
    args.push('-map', '0:v:0', '-frames:v', '1',
      '-vf', `scale=${maxPx}:${maxPx}:force_original_aspect_ratio=decrease`,
      '-q:v', '5', '-f', 'image2', 'pipe:1');
    const p = spawn(FFMPEG, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(p);
    const chunks = []; let err = '';
    const onAbort = () => { try { p.kill('SIGKILL'); } catch {} reject(new Error('aborted')); };
    if (signal) {
      if (signal.aborted) { try { p.kill('SIGKILL'); } catch {} return reject(new Error('aborted')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('ffmpeg timeout')); }, 30000);
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(t); activeChildren.delete(p); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      activeChildren.delete(p);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`));
    });
    p.stdin.on('error', () => {});   // 别让 EPIPE 崩掉进程
    if (isPath) p.stdin.end(); else p.stdin.end(input);
  });
}

// ---------------------------------------------------------------- 缩略图 / 封面
const prevJobs = new Map();

/** 读 JPEG 尺寸（宽度） */
function jpegWidth(buf) {
  try {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return buf.readUInt16BE(i + 7);
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch {}
  return 0;
}

/**
 * 生成（或复用）一张缩略图，最长边 <= THUMB_MAX，返回 {file, mime}
 * - JPG/PNG 等：ffmpeg 缩到 640px（原图十几 MB，缩完几十 KB，浏览器解码也轻）
 * - RAW：内外嵌 JPEG 预览，再统一缩到 640px（否则光是预览就能吃掉 14 GiB 缓存）
 * - HEIF / 视频：ffmpeg 直接抽帧缩小
 */
async function makePreview(absFile, rel, signal = null) {
  const ext = extOf(absFile);
  const kind = kindOf(absFile);
  let st;
  try { st = await fsp.stat(absFile); } catch { return null; }
  const key = sha1(`${rel}|${st.size}|${Math.round(st.mtimeMs)}|${PREV_VERSION}`);
  const out = path.join(PREV_DIR, key + '.jpg');

  // 已有缓存
  try { await fsp.access(out); return { file: out, mime: 'image/jpeg' }; } catch {}
  if (previewPaused) return null;   // 正在播放视频：不生成，避免抢 CPU/GPU
  if (prevJobs.has(key)) return prevJobs.get(key);

  const job = (async () => {
    await fsp.mkdir(PREV_DIR, { recursive: true });
    // 先写临时文件再改名：中途被杀掉（播放视频时会 kill）不会留下半张损坏的缓存
    const tmp = out.replace(/\.jpg$/, '.part.jpg');

    if (kind === 'raw') {
      const buf = extractEmbeddedJpeg(absFile);
      if (!buf) return null;
      const gate = gateFor(buf.length);
      let data = buf;
      if (jpegWidth(buf) > THUMB_MAX) {
        data = sharpLib
          ? await gate(() => sharpThumb(buf, THUMB_MAX), signal).catch(() => gate(() => ffmpegScaleBuffer(buf, THUMB_MAX, signal), signal))
          : await gate(() => ffmpegScaleBuffer(buf, THUMB_MAX, signal), signal);
      }
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, out);
      return { file: out, mime: 'image/jpeg' };
    }

    const scaled = `scale=${THUMB_MAX}:${THUMB_MAX}:force_original_aspect_ratio=decrease`;

    // 视频：优先 QSV 硬件解码抽帧（4K HEVC 用软件解会吃掉全核 CPU，正是“打开视频就卡”的元凶）
    if (kind === 'video') {
      const attempts = [
        { hw: ['-hwaccel', 'qsv'], vf: `hwdownload,format=p010le,${scaled},format=yuvj420p` },
        { hw: ['-hwaccel', 'qsv'], vf: `hwdownload,format=nv12,${scaled},format=yuvj420p` },
        { hw: [], vf: scaled },
      ];
      for (const at of attempts) {
        const args = ['-hide_banner', '-loglevel', 'error', '-y', ...at.hw, '-ss', '1', '-i', absFile,
          '-frames:v', '1', '-vf', at.vf, '-q:v', '5', tmp];
        try {
          await gateVideo(() => runFfmpeg(args, 30000, signal), signal);
          await fsp.rename(tmp, out);
          return { file: out, mime: 'image/jpeg' };
        } catch {
          try { await fsp.unlink(tmp); } catch {}
        }
      }
      return null;
    }

    // JPG：优先 sharp（快得多、不起进程）
    if (sharpLib && kind === 'jpg') {
      try {
        const data = await gateFor(st.size)(() => sharpThumb(absFile, THUMB_MAX), signal);
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, out);
        return { file: out, mime: 'image/jpeg' };
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // sharp 失败就继续走下面的 ffmpeg
      }
    }

    // JPG / HEIF（ffmpeg 兜底）
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', absFile, '-map', '0:v:0', '-frames:v', '1',
        '-vf', scaled, '-q:v', '5', tmp];
      await gateFor(st.size)(() => runFfmpeg(args, 30000, signal), signal);
      try { await fsp.unlink(out); } catch {}
      await fsp.rename(tmp, out);
      return { file: out, mime: 'image/jpeg' };
    } catch {
      try { await fsp.unlink(tmp); } catch {}
      if (kind === 'jpg') return { file: absFile, mime: MIME[ext] || 'image/jpeg' };   // 缩不了就发原图
      const buf = extractEmbeddedJpeg(absFile, 1024 * 1024);
      if (buf) { await fsp.writeFile(tmp, buf); await fsp.rename(tmp, out); return { file: out, mime: 'image/jpeg' }; }
      return null;
    }
  })().finally(() => prevJobs.delete(key));

  prevJobs.set(key, job);
  return job;
}

/** 大图预览（看大图用）
 *  - RAW：直接抽内嵌全尺寸 JPEG，不落盘
 *  - 超大 JPG/PNG：降采样到 2048px 并缓存（局域网/弱 WiFi 下关键，否则一张原图 52MB）
 *  - 其它：原图（想强制原图加 ?full=1）
 */
async function makeBigPreview(absFile, rel, signal = null) {
  const kind = kindOf(absFile);
  let st;
  try { st = await fsp.stat(absFile); } catch { return null; }

  if (kind === 'raw') {
    const buf = extractEmbeddedJpeg(absFile, 12 * 1024 * 1024);
    return buf ? { buffer: buf, mime: 'image/jpeg' } : null;
  }

  const BIG_MAX = 2048;
  // HEIF 必须转（浏览器根本不能解 HEIC）；JPG 只有超大时才缩
  if (kind === 'heif' || (kind === 'jpg' && st.size > 3 * 1024 * 1024)) {
    const key = sha1(`${rel}|${st.size}|${Math.round(st.mtimeMs)}|big${BIG_MAX}`);
    const out = path.join(PREV_DIR, key + '-big.jpg');
    try {
      await fsp.access(out);
    } catch {
      await fsp.mkdir(PREV_DIR, { recursive: true });
      const tmp = out.replace(/\.jpg$/, '.part.jpg');
      try {
        const buf = sharpLib && kind === 'jpg'
          ? await gateFor(st.size)(() => sharpThumb(absFile, BIG_MAX), signal).catch(() => null)
          : null;
        const data = buf || await gateFor(st.size)(() => ffmpegScaleBuffer(absFile, BIG_MAX, signal), signal);
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, out);
      } catch {
        try { await fsp.unlink(tmp); } catch {}
        return { file: absFile, mime: MIME[extOf(absFile)] || 'image/jpeg' };
      }
    }
    return { file: out, mime: 'image/jpeg' };
  }

  return { file: absFile, mime: MIME[extOf(absFile)] || 'image/jpeg' };
}

/** 缩略图缓存超限时，删最旧的（启动后、每次扫描后各跑一次） */
async function trimPrevCache() {
  try {
    const names = await fsp.readdir(PREV_DIR);
    let total = 0;
    const entries = [];
    for (const n of names) {
      const full = path.join(PREV_DIR, n);
      if (n.endsWith('.part.jpg')) { try { await fsp.unlink(full); } catch {} continue; }   // 被中断的临时文件
      try {
        const s = await fsp.stat(full);
        total += s.size;
        entries.push({ p: full, size: s.size, m: s.mtimeMs });
      } catch {}
    }
    if (total <= PREV_CAP_BYTES) return;
    entries.sort((a, b) => a.m - b.m);
    let over = total - PREV_CAP_BYTES * 0.9;
    let removed = 0;
    for (const e of entries) {
      if (over <= 0) break;
      try { await fsp.unlink(e.p); over -= e.size; removed++; } catch {}
    }
    console.log(`  缩略图缓存超限，已清理最旧的 ${removed} 个文件`);
  } catch {}
}

// ---------------------------------------------------------------- 扫描
const isImageKind = (k) => k === 'jpg' || k === 'raw' || k === 'heif';

async function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(fs.fstatSync(fd).size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

async function scanFolder(name) {
  const absRoot = path.join(ROOT, name);
  const folder = {
    name, rel: name, bytes: 0, files: 0,
    exts: {}, kinds: {}, subdirs: [], fileList: [],
    tMin: Infinity, tMax: 0, cover: null, exif: null,
  };
  const subMap = new Map();
  const imageCandidates = [];

  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(ents.map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.isFile()) return;
      if (IGNORE_FILES.has(e.name.toLowerCase())) return;
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      const ext = extOf(p);
      const kind = kindOf(p);

      folder.files++;
      folder.bytes += st.size;
      const ex = (folder.exts[ext] ||= { n: 0, b: 0 });
      ex.n++; ex.b += st.size;
      const kd = (folder.kinds[kind] ||= { n: 0, b: 0 });
      kd.n++; kd.b += st.size;
      if (st.mtimeMs < folder.tMin) folder.tMin = st.mtimeMs;
      if (st.mtimeMs > folder.tMax) folder.tMax = st.mtimeMs;
      folder.fileList.push([rel, st.size, Math.round(st.mtimeMs)]);

      const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (dirRel && dirRel !== name) {
        // 真正的子文件夹（相对该文件夹的路径）
        const sub = dirRel.slice(name.length + 1);
        const a = subMap.get(sub) || { rel: sub, name: path.posix.basename(sub) || sub, bytes: 0, files: 0, kinds: {} };
        a.bytes += st.size; a.files++;
        const kk = (a.kinds[kind] ||= { n: 0, b: 0 }); kk.n++; kk.b += st.size;
        subMap.set(sub, a);
      }
      if (isImageKind(kind) && imageCandidates.length < 12) imageCandidates.push(p);
    }));
  }

  await walk(absRoot);

  folder.fileList.sort((a, b) => a[0].localeCompare(b[0]));
  folder.subdirs = [...subMap.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  if (folder.tMin === Infinity) folder.tMin = 0;

  // 封面：优先 JPG，其次 RAW/HEIF
  const firstOf = (pred) => folder.fileList.find(([rel]) => pred(rel));
  const coverEntry =
    firstOf((rel) => kindOf(rel) === 'jpg' && !rel.includes('/')) ||
    firstOf((rel) => kindOf(rel) === 'jpg') ||
    firstOf((rel) => isImageKind(kindOf(rel)));
  folder.cover = coverEntry ? coverEntry[0] : null;

  // 抽样 EXIF（最多 3 张，只读文件头，很便宜）
  const samples = [];
  const imgs = imageCandidates.filter((p) => isImageKind(kindOf(p)));
  if (imgs.length) {
    const pick = [imgs[0], imgs[Math.floor(imgs.length / 2)], imgs[imgs.length - 1]];
    for (const p of pick) {
      if (!p) continue;
      const head = await readHead(p, 512 * 1024);
      if (!head) continue;
      const e = exifFromBuffer(head);
      if (e) samples.push(prettyExif(e));
    }
  }
  const cams = {};
  for (const s of samples) if (s && s.camera) cams[s.camera] = (cams[s.camera] || 0) + 1;
  folder.exif = {
    cameras: Object.entries(cams).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, n: v })),
    sample: samples.find(Boolean) || null,
  };

  return folder;
}

async function scanAll() {
  if (state.status === 'scanning') return;
  // 有旧数据（缓存）时保留展示，逐个大文件夹原地替换；全新扫描则从空开始
  const displayMap = new Map(state.folders.map((f) => [f.name, f]));
  const hadData = state.folders.length > 0;

  state.status = 'scanning';
  state.error = null;
  state.errors = [];
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.elapsedMs = 0;
  state.progress = { done: 0, total: 0, current: '', bytes: state.folders.reduce((a, f) => a + f.bytes, 0) };
  state.rescanOfCache = hadData;

  let ents;
  try { ents = await fsp.readdir(ROOT, { withFileTypes: true }); }
  catch (e) {
    state.status = 'error';
    state.error = `无法读取 ${ROOT}: ${e.message}`;
    return;
  }
  const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  state.progress.total = dirs.length;

  const queue = [...dirs];
  const fresh = new Map();
  const concurrency = 4;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const name = queue.shift();
      state.progress.current = name;
      try {
        const f = await scanFolder(name);
        fresh.set(name, f);
        displayMap.set(name, f);
        state.folders = [...displayMap.values()].sort((a, b) => a.name.localeCompare(b.name));
        state.progress.bytes = state.folders.reduce((a, x) => a + x.bytes, 0);
      } catch (e) {
        state.errors.push({ name, error: String((e && e.message) || e) });
      }
      state.progress.done++;
    }
  }));

  // 扫完了：只保留磁盘上确实存在的
  state.folders = [...fresh.values()].sort((a, b) => a.name.localeCompare(b.name));
  state.status = 'ready';
  state.fromCache = false;
  state.finishedAt = Date.now();
  state.elapsedMs = state.finishedAt - state.startedAt;
  saveCache();
  trimPrevCache();
}

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const payload = {
        version: CACHE_VERSION, root: ROOT, builtAt: Date.now(),
        elapsedMs: state.elapsedMs, folders: state.folders,
      };
      const tmp = INDEX_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(payload));
      await fsp.rename(tmp, INDEX_FILE);
    } catch (e) { console.error('缓存写入失败:', e.message); }
  }, 500);
}

async function loadCache() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION || path.resolve(data.root) !== ROOT) return false;
    state.folders = data.folders || [];
    state.elapsedMs = data.elapsedMs || 0;
    state.status = 'ready';
    state.fromCache = true;
    state.finishedAt = data.builtAt;
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- HTTP 工具
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, obj, req) {
  const buf = Buffer.from(JSON.stringify(obj));
  const accept = req?.headers['accept-encoding'] || '';
  if (accept.includes('gzip') && buf.length > 2048) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, 'Cache-Control': 'no-store' });
    return res.end(gz);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function resolveRel(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function serveFile(req, res, abs, { immutable = false, download = false } = {}) {
  let st;
  try { st = fs.statSync(abs); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not a file');

  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[extOf(abs)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    ETag: etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;

  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);

  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    let start = s ? parseInt(s, 10) : 0;
    let end = e ? parseInt(e, 10) : st.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

const PLACEHOLDER = (label) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#1b1f27"/>` +
  `<text x="160" y="168" font-size="20" fill="#5b6473" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`
);

// ---------------------------------------------------------------- 路由
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const rel = url.searchParams.get('rel') || '';

  if (p === '/' || p === '/index.html') {
    // 入口页不做长缓存，改了代码刷新就能看到
    const file = path.join(__dirname, 'public', 'index.html');
    let html;
    try { html = fs.readFileSync(file); } catch { return send(res, 500, 'index.html 不存在'); }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-cache, must-revalidate',
    });
    return res.end(html);
  }
  if (p === '/favicon.ico') return send(res, 204, '');

  // 扫描状态（前端轮询）
  if (p === '/api/state') {
    const t = totals();
    return sendJson(res, {
      root: ROOT, status: state.status, fromCache: state.fromCache,
      paused: previewPaused,
      urls: lanUrls(),
      startedAt: state.startedAt, finishedAt: state.finishedAt, elapsedMs: state.elapsedMs,
      progress: state.progress, totals: t, errors: state.errors,
      folders: state.folders.map((f) => ({
        name: f.name, rel: f.rel, bytes: f.bytes, files: f.files,
        exts: f.exts, kinds: f.kinds, subdirs: f.subdirs,
        tMin: f.tMin, tMax: f.tMax, cover: f.cover, exif: f.exif,
      })),
    }, req);
  }

  if (p === '/api/folder') {
    const f = state.folders.find((x) => x.rel === rel);
    if (!f) return sendJson(res, { error: 'not found' }, req);
    return sendJson(res, {
      name: f.name, rel: f.rel, bytes: f.bytes, files: f.files, exts: f.exts,
      kinds: f.kinds, subdirs: f.subdirs, exif: f.exif, fileList: f.fileList,
    }, req);
  }

  if (p === '/api/media') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    return serveFile(req, res, abs);
  }

  // 下载原文件：带正确的 Content-Disposition，否则浏览器会把文件名当 “media”、没有扩展名
  if (p === '/api/download') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    return serveFile(req, res, abs, { download: true });
  }

  if (p === '/api/exif') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    const head = await readHead(abs, 4 * 1024 * 1024);
    if (!head) return sendJson(res, { exif: null }, req);
    return sendJson(res, { exif: prettyExif(exifFromBuffer(head)) }, req);
  }

  // 缩略图（最长边 640px，统一缓存）
  if (p === '/api/prev') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    if (previewPaused) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(PLACEHOLDER('暂停'));
    }
    // 客户端走开（删掉 img.src / 关详情页 / 切文件夹）时，浏览器会取消请求，
    // 这里立刻 abort：排队中的任务丢弃、正在跑的 ffmpeg 直接 kill
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const r = await makePreview(abs, rel, ac.signal);
      if (ac.signal.aborted) return;
      if (!r) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' });
        return res.end(PLACEHOLDER(kindOf(abs).toUpperCase()));
      }
      return serveFile(req, res, r.file, { immutable: r.file !== abs });
    } catch (e) {
      if (ac.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(PLACEHOLDER('ERR'));
    }
  }

  // 大图预览（点开看大图时用；RAW 直接抽内嵌全尺寸 JPEG，不落盘）
  if (p === '/api/bigprev') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    if (url.searchParams.get('full')) return serveFile(req, res, abs);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const r = await makeBigPreview(abs, rel, ac.signal);
      if (ac.signal.aborted) return;
      if (!r) return send(res, 404, 'no preview');
      if (r.buffer) {
        res.writeHead(200, { 'Content-Type': r.mime, 'Content-Length': r.buffer.length, 'Cache-Control': 'public, max-age=86400' });
        return res.end(r.buffer);
      }
      return serveFile(req, res, r.file, { immutable: r.file !== abs });
    } catch {
      return send(res, 404, 'no preview');
    }
  }

  if (p === '/api/reveal') {
    const abs = resolveRel(rel);
    if (!abs) return send(res, 400, 'bad path');
    try {
      let st = null;
      try { st = fs.statSync(abs); } catch {}
      if (st && st.isDirectory()) spawn('explorer.exe', [abs], { detached: true, windowsHide: false }).unref();
      else spawn('explorer.exe', ['/select,', abs], { detached: true, windowsHide: false }).unref();
      return sendJson(res, { ok: true }, req);
    } catch (e) { return sendJson(res, { ok: false, error: String(e.message) }, req); }
  }

  if (p === '/api/rescan') {
    if (state.status !== 'scanning') setTimeout(scanAll, 50);
    return sendJson(res, { ok: true }, req);
  }

  if (p === '/api/preview/pause') {
    pausePreviews(Number(url.searchParams.get('t')) || 30);
    return sendJson(res, { ok: true, paused: true }, req);
  }
  if (p === '/api/preview/resume') {
    resumePreviews();
    return sendJson(res, { ok: true, paused: false }, req);
  }

  if (p === '/api/cache/clear') {
    try { await fsp.rm(PREV_DIR, { recursive: true, force: true }); } catch {}
    return sendJson(res, { ok: true }, req);
  }

  if (p === '/api/cache/stats') {
    let files = 0, bytes = 0;
    try {
      for (const n of await fsp.readdir(PREV_DIR)) {
        try { const s = await fsp.stat(path.join(PREV_DIR, n)); files++; bytes += s.size; } catch {}
      }
    } catch {}
    let idx = 0;
    try { idx = (await fsp.stat(INDEX_FILE)).size; } catch {}
    return sendJson(res, { files, bytes, index: idx, cap: PREV_CAP_BYTES }, req);
  }

  send(res, 404, 'not found');
}

// ---------------------------------------------------------------- 启动
(async () => {
  try { await fsp.mkdir(CACHE_DIR, { recursive: true }); } catch {}
  try { await fsp.writeFile(path.join(CACHE_DIR, 'server.pid'), String(process.pid)); } catch {}
  try { await fsp.writeFile(path.join(CACHE_DIR, 'port.txt'), String(PORT)); } catch {}
  const loaded = await loadCache();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('请求出错', req.url, e);
      try { send(res, 500, 'server error: ' + e.message); } catch {}
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`\n  照片库总览  →  http://localhost:${PORT}`);
    const lan = lanUrls();
    if (HOST === '0.0.0.0' && lan.length) {
      console.log('  局域网访问  →  ' + lan.join('\n                 '));
      console.log('  （手机/别的电脑用上面的地址；被防火墙拦就用管理员运行「开放局域网.bat」）');
    }
    console.log(`  目录: ${ROOT}  (PID ${process.pid})`);
    console.log(`  缩略图引擎: ${sharpLib ? 'sharp/libvips ' + sharpLib.versions.vips : 'ffmpeg（装 sharp 能快 3~5 倍：npm i sharp）'}`);
    console.log(`  CPU: ${CORES} 线程 → 并发 小图${LIGHT_N} / 大图${HEAVY_N}`);
    if (loaded) console.log(`  已加载缓存（${state.folders.length} 个文件夹），后台重新扫描中…`);
    console.log('  按 Ctrl+C 停止\n');
    setTimeout(scanAll, loaded ? 400 : 0);
    setTimeout(trimPrevCache, 3000);
    // 预热 ffmpeg：避免第一次生成缩略图时还要等杀软扫描进程（否则首次会多 1-2 秒）
    try { spawn(FFMPEG, ['-version'], { stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用，可设置 PORT=其他端口 再启动`);
    else console.error(e);
    process.exit(1);
  });
})();
