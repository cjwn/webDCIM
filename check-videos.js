'use strict';
// 体检：扫描所有视频，检查容器结构（faststart / moov 位置 / 是否损坏）
const fs = require('fs');
const path = require('path');

const ROOT = process.env.OUTPUT_ROOT || 'E:/OUTPUT';
const VIDEO = /\.(mp4|mov|m4v|avi)$/i;

function check(f) {
  const size = fs.statSync(f).size;
  const fd = fs.openSync(f, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, 4096, 0);
    let off = 0;
    while (off + 8 <= n) {
      const sz = head.readUInt32BE(off);
      const t = head.toString('latin1', off + 4, off + 8);
      if (t === 'moov') return { ok: true, fast: true };
      if (t === 'mdat') {
        const len = Math.min(size, 8 * 1048576);
        const tail = Buffer.alloc(len);
        fs.readSync(fd, tail, 0, len, size - len);
        return tail.indexOf(Buffer.from('moov')) >= 0
          ? { ok: true, fast: false }
          : { ok: false, reason: 'moov 缺失（文件可能没拷完）' };
      }
      if (!sz || sz < 8) break;
      off += sz;
    }
    return { ok: false, reason: '文件头异常' };
  } finally {
    fs.closeSync(fd);
  }
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (VIDEO.test(e.name)) files.push(p);
  }
})(ROOT);

let fast = 0, slow = 0, bad = 0;
const badList = [];
for (const f of files) {
  let r;
  try { r = check(f); } catch (e) { r = { ok: false, reason: e.message }; }
  if (r.ok) r.fast ? fast++ : slow++;
  else { bad++; badList.push([path.relative(ROOT, f).split(path.sep).join('/'), r.reason]); }
}

console.log(`视频总数: ${files.length}`);
console.log(`  faststart（可直接播）      : ${fast}`);
console.log(`  moov 在末尾（靠 Range 播）: ${slow}`);
console.log(`  损坏 / 不完整             : ${bad}`);
badList.slice(0, 15).forEach(([f, r]) => console.log(`   ✗ ${f} — ${r}`));
if (badList.length) {
  fs.writeFileSync(path.join(__dirname, 'cache', 'broken-videos.txt'),
    badList.map(([f, r]) => f + '\t' + r).join('\n'), 'utf8');
  console.log(`\n完整列表已写入 cache/broken-videos.txt`);
}
