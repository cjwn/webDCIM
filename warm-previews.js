#!/usr/bin/env node
/**
 * 批量预热缩略图 / 视频封面
 *
 *   node warm-previews.js                  # 只补视频封面（推荐，最省）
 *   node warm-previews.js --all            # 连图片缩略图一起补（会跑很久）
 *   node warm-previews.js --folder 2016-01-01
 *   node warm-previews.js --concurrency 2  # 默认 1（最省 CPU/GPU）
 *   node warm-previews.js --dry-run        # 只统计要生成多少个
 *
 * 工作原理：直接请求服务端的 /api/prev，走的是完全相同的生成管线（QSV 硬解 + 缓存），
 * 所以已经生成过的会秒回（缓存命中），不会重复干活。
 */
'use strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:7788';

const args = process.argv.slice(2);
const opt = {
  all: args.includes('--all'),
  covers: args.includes('--covers'),
  dryRun: args.includes('--dry-run'),
  folder: (() => { const i = args.indexOf('--folder'); return i >= 0 ? args[i + 1] : null; })(),
  concurrency: (() => { const i = args.indexOf('--concurrency'); return i >= 0 ? Number(args[i + 1]) || 1 : 1; })(),
};

const VIDEO = /\.(mp4|mov|avi|m4v|mkv|mts|m2ts|3gp|wmv)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|bmp|tiff?|avif)$/i;      // RAW/HEIF 不算（它们走内嵌预览，很快）
const fmt = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');
const fmtSize = (b) => (b ? (b / 1048576).toFixed(1) + ' MB' : '0 B');

async function jget(u) {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
  return r.json();
}

(async () => {
  console.log('服务端:', BASE);
  const st = await jget('/api/state');
  console.log(`照片库: ${st.folders.length} 个文件夹 / ${st.totals.files.toLocaleString()} 个文件`);

  const folders = opt.folder ? st.folders.filter((f) => f.rel === opt.folder) : st.folders;
  if (!folders.length) { console.error('没有匹配的文件夹:', opt.folder); process.exit(1); }

  // --covers：只给每个文件夹生成一张封面（视频文件夹也能有封面），代价最小
  if (opt.covers) {
    const list = folders.filter((f) => f.cover).map((f) => f.cover);
    console.log(`只补文件夹封面: ${list.length} 个`);
    if (opt.dryRun) return;
    let ok = 0, bad = 0;
    const t = Date.now();
    for (const rel of list) {
      const r = await fetch(BASE + '/api/prev?force=1&rel=' + encodeURIComponent(rel));
      (r.headers.get('content-type') || '').includes('jpeg') ? ok++ : bad++;
    }
    console.log(`完成：${ok} 个成功，${bad} 个失败，用时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return;
  }

  // 收集目标
  const queue = [];
  for (const f of folders) {
    let data;
    try { data = await jget('/api/folder?rel=' + encodeURIComponent(f.rel)); } catch { continue; }
    for (const [rel] of data.fileList || []) {
      if (VIDEO.test(rel)) queue.push(rel);
      else if (opt.all && IMAGE.test(rel)) queue.push(rel);
    }
  }
  console.log(`待处理: ${queue.length.toLocaleString()} 个${opt.all ? '' : '视频'}` +
    `（并发 ${opt.concurrency}）`);
  if (opt.dryRun) return;

  let done = 0, fail = 0, bytes = 0, fresh = 0;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const rel = queue.shift();
      if (!rel) return;
      const t = Date.now();
      try {
        // force=1：批量预热时不被“正在播放视频导致的暂停”挡住
        const r = await fetch(BASE + '/api/prev?force=1&rel=' + encodeURIComponent(rel));
        const buf = Buffer.from(await r.arrayBuffer());
        if ((r.headers.get('content-type') || '').includes('jpeg')) {
          bytes += buf.length;
          if (Date.now() - t > 200) fresh++;      // 超过 200ms 视为新生成，其余是缓存命中
        } else {
          fail++;
          if (fail <= 10) console.log('  ✗ 生成失败:', rel);
        }
      } catch { fail++; }
      done++;
      if (done % 25 === 0 || done === queue.length) {
        const el = Date.now() - t0;
        const per = el / done;
        const left = per * (queue.length + 0);
        process.stdout.write(`\r  进度 ${done}/${done + queue.length}  ` +
          `用时 ${fmt(el)}  ` +
          `平均 ${fmt(per)}/个  ` +
          `预计剩余 ${fmt(left)}  ` +
          `新生成 ${fresh}  失败 ${fail}  产出 ${fmtSize(bytes)}      `);
      }
    }
  };

  await Promise.all(Array.from({ length: opt.concurrency }, worker));
  const el = Date.now() - t0;
  console.log(`\n完成：${done} 个，用时 ${fmt(el)}，平均 ${fmt(el / done)}/个，` +
    `新生成 ${fresh}，失败 ${fail}，产出 ${fmtSize(bytes)}`);
})();
