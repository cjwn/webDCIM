/**
 * 大图灯箱：打开/关闭、视频播放、EXIF 展示、预加载、transform 缩放/平移/触控/全屏
 */
'use strict';

// ---------------------------------------------------------------- 大图
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const g = (window._shownGroups || [])[+card.dataset.i];
  if (!g) return;
  // 缩略图关闭模式：第一次点击先加载缩略图
  if (card.classList.contains('ph') && card.dataset.loaded !== '1') {
    loadCardThumb(card, g);
    return;
  }
  openLightbox(+card.dataset.i);
});

let lbVideoTimer = null;
/** 彻底停掉并移除画布里的视频、超时定时器和视频报错浮层 */
function lbClearVideo() {
  if (lbVideoTimer) { clearTimeout(lbVideoTimer); lbVideoTimer = null; }
  const errBox = $('#lbVErr');
  if (errBox) errBox.remove();
  const canvasEl = $('#lbCanvas');
  if (canvasEl) canvasEl.querySelectorAll('video').forEach((v) => {
    v.dataset.dead = '1';
    try { v.pause(); } catch {}
    try { v.removeAttribute('src'); v.load(); } catch {}   // 释放解码器并中断下载连接
    v.remove();
  });
}

/** 清空大图舞台：必须显式 pause + 解除 src，否则 display:none 藏起来后视频还会继续响 */
function clearStage() {
  const stage = $('#lbStage');
  if (!stage) return;
  lbClearVideo();
  lbSpinner(false);
  lbLoading = false;
  stage.classList.remove('zoomed');
  stage.classList.remove('dragging');
  lbDrag = null;
  lbTouch = null;
  lbPinch = null;
  lbView = null;
  lbLastDragAt = 0;
  if (typeof lbSettleTimer !== 'undefined' && lbSettleTimer) {
    clearTimeout(lbSettleTimer);
    lbSettleTimer = null;
  }
  const canvasEl = $('#lbCanvas');
  if (canvasEl) {
    canvasEl.scrollLeft = 0;
    canvasEl.scrollTop = 0;
  }
  if (canvasEl) canvasEl.querySelectorAll('img').forEach((i) => {
    try { i.removeAttribute('src'); } catch {}
    i.remove();
  });
  lbResetSharpState();
}

function isVideoGroup(g) {
  return g.kinds.includes('video') && !g.kinds.some((k) => k === 'raw' || k === 'jpg' || k === 'heif');
}
function bigSrcFor(g) {
  const jpg = g.items.find((x) => x.kind === 'jpg');
  if (jpg) return bigQuality === 'full' ? '/api/media?rel=' + enc(jpg.rel) : '/api/bigprev?rel=' + enc(jpg.rel);
  const heif = g.items.find((x) => x.kind === 'heif');
  if (heif) return '/api/bigprev?rel=' + enc(heif.rel);
  const p = g.preview;
  if (p.kind === 'raw' || p.kind === 'heif') return '/api/bigprev?rel=' + enc(p.rel);
  return '/api/media?rel=' + enc(p.rel);
}
function exifRelFor(g) {
  if (!g || isVideoGroup(g)) return null;
  const jpg = g.items.find((x) => x.kind === 'jpg');
  return jpg ? jpg.rel : (g.preview && g.preview.rel) || null;
}
function fetchExifCached(rel) {
  if (!rel) return Promise.resolve(null);
  if (lbExifCache.has(rel)) return Promise.resolve(lbExifCache.get(rel));
  return fetch('/api/exif?rel=' + enc(rel))
    .then((r) => r.json())
    .then((d) => {
      const e = (d && d.exif) || null;
      lbExifCache.set(rel, e);
      if (lbExifCache.size > 500) lbExifCache.delete(lbExifCache.keys().next().value);
      return e;
    })
    .catch(() => null);
}
function cancelLbPrefetch() {
  clearTimeout(lbPrefetchTimer);
  lbPrefetchTimer = null;
}
let lbExifEnabled = (() => {
  try {
    const v = localStorage.getItem('lbExifOn');
    return v === null ? true : v === '1';
  } catch { return true; }
})();

function loadCurrentLbExif(g) {
  const token = ++lbExifToken;
  const btn = $('#btnExifToggle');
  if (btn) {
    btn.classList.toggle('active', lbExifEnabled);
    btn.setAttribute('aria-pressed', lbExifEnabled ? 'true' : 'false');
    btn.title = lbExifEnabled ? '已开启 EXIF 读取（点击关闭以跳过请求）' : '点击开启并读取 EXIF 信息';
  }
  if (!lbExifEnabled) {
    lbCurrentExif = null;
    renderLbSharpUI();
    const el = $('#lbExif');
    if (el) { el.style.color = 'var(--fg3)'; el.textContent = '未开启'; }
    for (const id of ['lbDate', 'lbDateB', 'lbDims', 'lbDimsB']) {
      const n = $('#' + id);
      if (n) n.style.display = 'none';
    }
    return;
  }
  const el = $('#lbExif');
  if (el) { el.style.color = 'var(--fg2)'; el.textContent = '读取中…'; }
  const exifRel = exifRelFor(g);
  if (!exifRel) {
    applyLbExif(null);
  } else if (lbExifCache.has(exifRel)) {
    applyLbExif(lbExifCache.get(exifRel));
  } else {
    fetchExifCached(exifRel).then((e) => {
      if (lbExifToken !== token || !lbExifEnabled) return;
      applyLbExif(e);
    });
  }
}

function toggleLbExif() {
  lbExifEnabled = !lbExifEnabled;
  try { localStorage.setItem('lbExifOn', lbExifEnabled ? '1' : '0'); } catch {}
  const g = (window._shownGroups || [])[lbIndex];
  if (g) loadCurrentLbExif(g);
}

$('#lbInfo').addEventListener('click', (e) => {
  const exifBtn = e.target.closest('#btnExifToggle');
  if (exifBtn) {
    e.stopPropagation();
    toggleLbExif();
    return;
  }
  const sharpBtn = e.target.closest('#btnSharpToggle');
  if (sharpBtn) {
    e.stopPropagation();
    toggleLbSharpness();
  }
});

function scheduleLbPrefetch(idx) {
  cancelLbPrefetch();
  lbPrefetchTimer = setTimeout(() => {
    if (!$('#lb').classList.contains('show') || lbIndex !== idx) return;
    const groups = window._shownGroups || [];
    const n = groups.length;
    if (n <= 1) return;
    const targets = n === 2 ? [(idx + 1) % n] : [(idx + 1) % n, (idx - 1 + n) % n];
    lbPrefetchImgs = [];
    for (const ti of targets) {
      const g = groups[ti];
      if (!g || isVideoGroup(g)) continue;
      const im = new Image();
      im.decoding = 'async';
      im.src = bigSrcFor(g);
      lbPrefetchImgs.push(im);
      if (lbExifEnabled) {
        const erel = exifRelFor(g);
        if (erel && !lbExifCache.has(erel)) fetchExifCached(erel);
      }
    }
  }, 120);
}
function applyLbExif(e) {
  lbCurrentExif = e || null;
  renderLbSharpUI();
  const el = $('#lbExif'); if (!el) return;
  const kv = (id, idB, val) => {
    const v = $('#' + id), b = $('#' + idB);
    if (!v || !b) return;
    if (!val) { v.style.display = 'none'; b.style.display = 'none'; return; }
    v.textContent = val;
    v.style.display = ''; b.style.display = '';
  };
  kv('lbDate', 'lbDateB', e && e.date);
  kv('lbDims', 'lbDimsB', e && e.dims);
  if (!e) { el.textContent = '无'; return; }
  // 拍摄参数（f/快门/ISO/焦距）挤在同一行且不折行；其余各占一行
  const expo = [e.focal, e.f, e.shutter, e.iso].filter(Boolean).join(' · ');
  const lines = [e.camera, e.lens, expo].filter(Boolean);
  el.textContent = '';
  if (!lines.length) { el.textContent = '无'; return; }
  lines.forEach((t, i) => {
    if (i) el.appendChild(document.createTextNode('\n'));
    const s = document.createElement('span');
    s.textContent = t;
    if (t === expo && expo) { s.style.whiteSpace = 'nowrap'; s.style.overflowWrap = 'normal'; s.style.wordBreak = 'keep-all'; }
    el.appendChild(s);
  });
}

async function openLightbox(i, opts = {}) {
  const groups = window._shownGroups || [];
  const g = groups[i]; if (!g) return;
  cancelLbPrefetch();
  lbIndex = i;
  const isVideo = isVideoGroup(g);
  const p = g.preview;
  const stage = $('#lbStage');
  const canvasEl = $('#lbCanvas');

  // 每次切图/切视频前都先停掉残留视频、清掉超时定时器和报错浮层（避免后台继续占连接下载大视频）
  lbClearVideo();
  lbHidePeakCanvas();
  lbCurrentSharp = null;
  lbCurrentExif = null;
  lbCurrentPeakData = null;
  lbSharpToken++;
  // 图片 → 图片：先留着旧图（不黑屏），新图加载好再替换
  const prevImg = (lbView && lbView.img && canvasEl && canvasEl.contains(lbView.img))
    ? lbView.img : null;
  lbDropPending();
  if (!prevImg) clearStage();                 // 视频 / 第一张：清空画布
  if (prevImg) prevImg.classList.add('lb-stale');
  lbLoading = true;
  lbSpinner(true);

  if (isVideo) {
    const v = document.createElement('video');
    v.src = '/api/play?rel=' + enc(g.videos[0]);   // 非 faststart 的会在服务端无损 remux 一次
    v.controls = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('tabindex', '-1');   // 别抢焦点，否则左右方向键会被视频拿去快进
    canvasEl.appendChild(v);
    v.blur();
    const isAlive = () => v.dataset.dead !== '1' && canvasEl.contains(v);
    const vDone = () => {
      if (!isAlive()) return;
      if (lbVideoTimer) { clearTimeout(lbVideoTimer); lbVideoTimer = null; }
      lbSpinner(false);
      lbLoading = false;
      // 视频有画面之后再撤掉垫底的旧图
      requestAnimationFrame(() => requestAnimationFrame(() => { if (isAlive()) lbKeepOnly(null); }));
    };
    v.addEventListener('loadeddata', vDone, { once: true });
    v.addEventListener('error', () => {
      if (!isAlive()) return;
      vDone();
      lbShowVideoError(g, v);
    }, { once: true });
    // 兜底：30 秒还没画面，也提示用户（半截文件、moov 损坏等）
    lbVideoTimer = setTimeout(() => {
      lbVideoTimer = null;
      if (!isAlive()) return;
      if (v.readyState < 2) { lbSpinner(false); lbLoading = false; lbShowVideoError(g, v); }
    }, 30000);
  } else {
    const img = document.createElement('img');
    img.dataset.pending = '1';
    const jpg = g.items.find((x) => x.kind === 'jpg');
    // 有 JPG 就用原图/2048预览；只有 RAW / HEIF 时用服务端预览（浏览器不能解码）
    img.src = bigSrcFor(g);
    img.style.visibility = 'hidden';   // 等 lbReset 把尺寸/缩放摆好再显形
    canvasEl.appendChild(img);

    const finish = async () => {
      if (!img.naturalWidth) return;
      if (!canvasEl.contains(img)) return;      // 期间已被 clearStage 清掉，作废
      // Safari：load 事件只代表“数据到了”，位图可能还没解码完。
      // 这时候如果先移除旧图，画布会露出底色（黑屏）。所以先等 decode()。
      try { if (img.decode) await img.decode(); } catch {}
      if (!canvasEl.contains(img)) return;
      img.removeAttribute('data-pending');
      lbReset(img);                    // 新图先就位并显形（压在旧图上面）
      lbSpinner(false);
      lbLoading = false;
      // 再等两帧确保新图真的画出来了，才把旧图移除 —— 彻底避免中间闪黑
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (canvasEl.contains(img)) lbKeepOnly(img);
      }));
      // 当前图已就绪：静默预取相邻的大图和 EXIF，连按方向键秒切
      scheduleLbPrefetch(i);
      // 异步计算清晰度指数与峰值对焦底图（不阻塞首帧渲染）
      scheduleLbSharpness(img, g, false);
    };
    img.addEventListener('load', finish, { once: true });
    img.addEventListener('error', () => { lbSpinner(false); lbLoading = false; }, { once: true });
    if (img.complete && img.naturalWidth) finish();
    // 加载完成后把真实像素尺寸显示出来，方便确认当前看的是原图还是预览
    img.addEventListener('load', () => {
      const nt = $('#qualityNote');
      if (!nt) return;
      const tag = !jpg
        ? (p.kind === 'raw' ? 'RAW 内嵌预览' : 'HEIF 转码预览')
        : (bigQuality === 'full' ? '原图' : '高清预览');
      nt.textContent = `${tag} · ${img.naturalWidth}×${img.naturalHeight}`;
    });
  }

  // 画质开关：只有“有 JPG 同号”的组才有意义
  const hasJpg = !!g.items.find((x) => x.kind === 'jpg');
  const qSeg = $('#qualitySeg');
  const forceBtn = $('#lbForceFull');
  if (forceBtn) {
    const jpgItem = g.items.find((x) => x.kind === 'jpg');
    const bigEnough = !!jpgItem && jpgItem.size > 3 * 1024 * 1024;
    forceBtn.style.display = (hasJpg && bigQuality === 'preview' && bigEnough) ? '' : 'none';
  }
  if (qSeg) {
    qSeg.style.display = hasJpg ? '' : 'none';
    [...qSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.q === bigQuality));
    const note = $('#qualityNote');
    if (note) {
      if (!hasJpg) {
        note.textContent = p.kind === 'raw' ? '显示的是 RAW 内嵌预览（浏览器无法解码 RAW）'
          : (p.kind === 'heif' ? 'HEIF 已转码为 JPEG 预览' : '');
      } else if (bigQuality === 'full') {
        note.textContent = '原图加载中…（文件可能很大）';
      } else {
        note.textContent = '生成 2048px 预览中…';
      }
    }
  }
  // 峰值对焦开关：所有非视频照片均可用
  const peakWrap = $('#peakWrap');
  if (peakWrap) {
    peakWrap.style.display = isVideo ? 'none' : '';
    syncPeakUI();
  }
  // RAW 提亮/暗部预览控件：只要同组有 RAW 且非纯视频就显示，切图自动复位
  const hasRaw = !isVideo && !!g.items.find((x) => x.kind === 'raw');
  const rawWrap = $('#rawDevWrap');
  if (rawWrap) {
    rawWrap.style.display = hasRaw ? '' : 'none';
    resetRawDevState();
  }
  $('#lbName').textContent = p.name;
  const info = [
    ['大小', g.items.map((x) => `${x.ext.replace('.', '')} ${fmtSize(x.size)}`).join('  ·  ')],
    ['类型', g.items.map((x) => x.ext.replace('.', '')).join(' + ')],
    ['路径', g.main.rel],
  ];
  // 拍摄时间 / 尺寸 / 清晰度 放在 kv 网格里（跟 大小/类型/路径 同级），排在 EXIF 下面。
  // EXIF 为可切换按钮：激活时读取并显示，关闭时不发请求也不显示。
  $('#lbInfo').innerHTML = info.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('') +
    `<button type="button" id="btnExifToggle" class="kv-btn${lbExifEnabled ? ' active' : ''}" aria-pressed="${lbExifEnabled ? 'true' : 'false'}">EXIF</button>` +
    `<span id="lbExif" style="color:${lbExifEnabled ? 'var(--fg2)' : 'var(--fg3)'};white-space:pre-line">${lbExifEnabled ? '读取中…' : '未开启'}</span>` +
    `<b id="lbDateB" style="display:none">拍摄时间</b><span id="lbDate" style="display:none"></span>` +
    `<b id="lbDimsB" style="display:none">尺寸</b><span id="lbDims" style="display:none"></span>` +
    (isVideo ? '' : `<button type="button" id="btnSharpToggle" class="kv-btn${lbSharpEnabled ? ' active' : ''}" aria-pressed="${lbSharpEnabled ? 'true' : 'false'}" title="${lbSharpEnabled ? '已开启清晰度分析（点击关闭以跳过计算）' : '点击开启清晰度分析'}">清晰度</button><span id="lbSharp" style="color:var(--fg3)">${lbSharpEnabled ? '分析中…' : '未开启'}</span>`);

  // 下载走 /api/download：响应带 Content-Disposition，文件名和扩展名才正确
  const shown = g.items.find((x) => x.kind === 'jpg') || g.items.find((x) => x.kind === 'heif') || p;
  const dl = $('#lbDownload');
  dl.href = '/api/download?rel=' + enc(shown.rel);
  dl.setAttribute('download', shown.name);
  const rawItem = shown.kind === 'raw' ? null : g.items.find((x) => x.kind === 'raw');
  const dlRaw = $('#lbDownloadRaw');
  if (rawItem) {
    dlRaw.style.display = '';
    dlRaw.href = '/api/download?rel=' + enc(rawItem.rel);
    dlRaw.setAttribute('download', rawItem.name);
  } else {
    dlRaw.style.display = 'none';
  }
  const delBtn = $('#lbDelete');
  if (delBtn) delBtn.style.display = STATE.isLocal === false ? 'none' : '';
  syncLbFavUI(g);
  $('#lb').classList.add('show');
  lbSyncFillBtn();

  // 播视频时把所有缩略图生成/下载停掉（否则 ffmpeg 抽帧 + 浏览器解码 4K 双重抢硬件，必卡）
  if (isVideo) pauseThumbWork(); else resumeThumbWork();

  // 历史记录：push 一条带照片的地址，后退键就能退回网格
  const mode = opts.mode || 'push';
  if (mode !== 'none' && currentFolder) {
    const pid = currentFolder.isFavorites ? g.base : groupBase(g);
    const url = hashFor(currentFolder.rel, pid);
    const st = { folder: currentFolder.rel, p: pid };
    if (mode === 'replace') history.replaceState(st, '', url);
    else if (location.hash !== url) history.pushState(st, '', url);
  }

  loadCurrentLbExif(g);
}

// ---------------------------------------------------------------- 收藏切换
let favReqSeq = 0;
function syncLbFavUI(g) {
  const cur = g || (window._shownGroups || [])[lbIndex];
  const on = !!(cur && isGroupFavorited(cur));
  const badge = $('#lbFavBadge');
  if (badge) {
    badge.classList.toggle('active', on);
    badge.setAttribute('aria-pressed', on ? 'true' : 'false');
    badge.innerHTML = on
      ? '<span class="star">★</span> 已收藏'
      : '<span class="star">☆</span> 收藏 [D]';
    badge.title = on ? '已收藏（点击或按 D 取消收藏）' : '收藏当前照片（快捷键 D）';
  }
}

function syncGridFavCard(base, on) {
  const groups = window._shownGroups || [];
  const idx = groups.findIndex((x) => x.base === base);
  if (idx < 0) return;
  const card = document.querySelector(`#grid .card[data-i="${idx}"]`);
  if (!card) return;
  let mark = card.querySelector('.fav-mark');
  if (on) {
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'fav-mark';
      mark.title = '已收藏';
      mark.textContent = '★';
      card.appendChild(mark);
    }
  } else if (mark) {
    mark.remove();
  }
}

async function toggleCurrentFavorite() {
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || !g.base) return;
  const base = g.base;
  const prev = favoriteSet.has(base);
  const next = !prev;
  const seq = ++favReqSeq;

  favPendingIntent.set(base, { target: next, seq });
  if (next) {
    favoriteSet.add(base);
    favoriteAddedAt[base] = Date.now();
  } else {
    favoriteSet.delete(base);
    delete favoriteAddedAt[base];
  }
  if (currentFolder && currentFolder.isFavorites) {
    favDirtyInDetail = true;
  }
  syncLbFavUI(g);
  syncGridFavCard(base, next);

  if (next) toast('★ 已收藏');
  else if (currentFolder && currentFolder.isFavorites) toast('已取消收藏（再按 D 可撤回）');
  else toast('已取消收藏');

  try {
    const r = await fetch('/api/favorites/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, favorite: next }),
    });
    const d = await r.json();
    const curIntent = favPendingIntent.get(base);
    if (curIntent && curIntent.seq === seq) favPendingIntent.delete(base);
    if (!d || !d.ok) throw new Error((d && d.error) || '收藏操作失败');
    if (d.favorites) {
      STATE.favorites = d.favorites;
      syncFavoritesFromState(d.favorites);
      renderHeader();
    }
    const curG = (window._shownGroups || [])[lbIndex];
    if (curG && curG.base === base) syncLbFavUI(curG);
    syncGridFavCard(base, favoriteSet.has(base));
  } catch (e) {
    const curIntent = favPendingIntent.get(base);
    if (curIntent && curIntent.seq === seq) {
      favPendingIntent.delete(base);
      if (prev) favoriteSet.add(base);
      else favoriteSet.delete(base);
      const curG = (window._shownGroups || [])[lbIndex];
      if (curG && curG.base === base) syncLbFavUI(curG);
      syncGridFavCard(base, prev);
      toast('收藏保存失败：' + e.message);
    }
  }
}

let lbLastDir = 1;
function lbMove(d) {
  const groups = window._shownGroups || [];
  const n = groups.length; if (!n) return;
  lbLastDir = d < 0 ? -1 : 1;
  // 翻页用 replaceState：否则连翻 20 张就要按 20 次后退才能出去
  openLightbox((lbIndex + d + n) % n, { mode: 'replace' });
}

/** 暂停缩略图：断掉懒加载、取消未完成的图片请求、通知服务端杀掉正在跑的 ffmpeg */
async function pauseThumbWork() {
  if (thumbWorkPaused) return;
  thumbWorkPaused = true;
  if (gridIO) { gridIO.disconnect(); gridIO = null; }
  abortGridDownloads();
  const beat = () => { fetch('/api/preview/pause', { method: 'POST' }).catch(() => {}); };
  beat();
  // 心跳续期：避免“关标签页/刷新”时来不及发 resume，导致服务端一直被挂住
  clearInterval(pauseHeartbeat);
  pauseHeartbeat = setInterval(beat, 10000);
}

/** 恢复缩略图：重新渲染网格，重新开始懒加载 */
async function resumeThumbWork() {
  clearInterval(pauseHeartbeat);
  pauseHeartbeat = null;
  if (!thumbWorkPaused) {
    // 页面刚打开也要确保服务端没有残留暂停状态
    fetch('/api/preview/resume', { method: 'POST' }).catch(() => {});
    return;
  }
  thumbWorkPaused = false;
  try { await fetch('/api/preview/resume', { method: 'POST' }); } catch {}
  if (currentFolder) renderGrid();
}

// 关标签页 / 刷新 / 切走时立即解除暂停（心跳意外失败也安全）
function releaseOnLeave() {
  if (!thumbWorkPaused) return;
  try { navigator.sendBeacon('/api/preview/resume'); } catch {}
}
window.addEventListener('pagehide', releaseOnLeave);
window.addEventListener('beforeunload', releaseOnLeave);

/** 关大图；updateHistory=true 时后退一格（回到网格） */
function closeLightbox(updateHistory = true) {
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
  cancelLbPrefetch();
  clearStage();                  // 先停掉视频/释放解码器
  $('#lb').classList.remove('show');
  lbIndex = -1;
  lbLastDir = 1;
  lbExifToken++;                  // 作废在途的 EXIF 请求，别让它回来写已关闭的灯箱
  if (currentFolder && currentFolder.isFavorites && favDirtyInDetail) {
    favDirtyInDetail = false;
    refreshFavoritesDetailFromLocal();
  }
  resumeThumbWork();
  if (!updateHistory) return;
  if (history.state && history.state.p) {
    history.back();
  } else if (currentFolder) {
    history.replaceState({ folder: currentFolder.rel }, '', hashFor(currentFolder.rel));
  } else {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

$('#lbPrev').addEventListener('click', () => lbMove(-1));
$('#lbNext').addEventListener('click', () => lbMove(1));

// ================= 大图查看：transform 缩放（原生手感） =================
// 用 transform: translate + scale，而不是改 width/height
// —— 不触发布局重排，缩放/平移只走合成层，才能真正顺滑
const LB_MAX_ZOOM = 4;      // 相对原图 100% 的最高 4 倍（= 400%）
const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));

let lbView = null;          // { img, nw, nh, scale, tx, ty }
let lbLastDragAt = 0;    // 上一次真实拖拽结束的时间
const lbJustDragged = () => Date.now() - lbLastDragAt < 350;
let lbApplyQueued = false;

let lbLoading = false;
function lbSpinner(on) { const el = $('#lbSpin'); if (el) el.classList.toggle('show', !!on); }

/** 视频放不出来时给一个明确的提示（而不是一直黑屏） */
function lbShowVideoError(g, video) {
  const canvas = lbCanvas();
  if (!canvas) return;
  const old = $('#lbVErr'); if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'lbVErr';
  const code = video && video.error ? video.error.code : 0;
  const reason = code === 4 ? '浏览器不支持这个视频的编码（H.264 4:2:2 10-bit 等专业格式都放不了）'
    : code === 3 ? '视频文件解码失败（可能拷贝不完整）'
    : code === 2 ? '读取视频时出错'
    : '视频加载超时（文件很大或索引在末尾，可能还在后台转换）';
  const rel = g && g.videos && g.videos[0] ? g.videos[0] : '';
  box.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:8;' +
    'background:rgba(20,25,34,.94);border:1px solid var(--line);border-radius:12px;padding:18px 22px;' +
    'max-width:min(420px,80vw);text-align:center;font-size:13px;line-height:1.7';
  box.innerHTML = '<div style="font-size:15px;margin-bottom:6px">⚠ 无法在浏览器里播放</div>' +
    '<div style="color:var(--fg2)">' + reason + '</div>' +
    '<div style="color:var(--fg3);font-size:11.5px;margin-top:8px;word-break:break-all">' + (rel.split('/').pop() || '') + '</div>';
  const bar = document.createElement('div');
  bar.style.cssText = 'margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap';
  const b1 = document.createElement('button'); b1.textContent = '📂 用本地播放器打开';
  b1.addEventListener('click', (ev) => { ev.stopPropagation(); fetch('/api/reveal?rel=' + enc(rel)).then(() => toast(`已在${fileManagerName()}中定位`)); });
  const b2 = document.createElement('button'); b2.textContent = '⬇ 下载';
  b2.addEventListener('click', (ev) => { ev.stopPropagation(); location.href = '/api/download?rel=' + enc(rel); });
  const b3 = document.createElement('button'); b3.textContent = '关闭';
  b3.addEventListener('click', (ev) => { ev.stopPropagation(); box.remove(); });
  bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3);
  box.appendChild(bar);
  canvas.appendChild(box);
}
/** 清掉所有“还没加载完”的待换图片 */
function lbDropPending() {
  const c = lbCanvas();
  if (c) c.querySelectorAll('img[data-pending="1"]').forEach((i) => i.remove());
}
/** 只保留 keep 这一张图 */
function lbKeepOnly(keep) {
  const c = lbCanvas();
  if (!c) return;
  // 只清理“已经用过”的旧图，别把刚发起、还在加载的新图一起删了
  c.querySelectorAll('img').forEach((i) => {
    if (i !== keep && i.dataset.pending !== '1') i.remove();
  });
}

function lbImg() {
  const c = $('#lbCanvas');
  return c ? c.querySelector('img') : null;
}
function lbCanvas() { return $('#lbCanvas'); }

/** 适应屏幕时的倍率（相对原图像素）；小图不放大，最多 1 */
// 全屏下默认“填充”（裁切四周铺满，无黑边）；可切回“完整”（保留整张图，可能有黑边）
let lbFillMode = localStorage.getItem('lbFillMode') === 'contain' ? 'contain' : 'fill';
const lbIsFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function lbFitScale() {
  const v = lbView, c = lbCanvas(), stage = $('#lbStage');
  if (!v || !c || !stage) return 1;
  const fs = lbIsFullscreen();
  // 一律用整个舞台/屏幕，不给导航箭头预留 —— 箭头直接浮在图片上面
  const availW = Math.max(80, stage.clientWidth);
  const availH = Math.max(80, stage.clientHeight);
  const contain = Math.min(availW / v.nw, availH / v.nh, 1);
  if (fs && lbFillMode === 'fill') {
    return Math.min(1, Math.max(availW / v.nw, availH / v.nh));   // cover：铺满并裁掉溢出部分
  }
  return contain;
}

/** 当前画面是否比画布大（可以拖动 / 需要显示抓手） */
function lbHasOverflow() {
  const v = lbView, c = lbCanvas();
  if (!v || !c) return false;
  return v.nw * v.scale > c.clientWidth + 1 || v.nh * v.scale > c.clientHeight + 1;
}

let lbAnimTimer = null;
let lbSettleTimer = null;
/**
 * 缩放停稳后把实际显示倍率（<= 1）固化到 img 的布局宽高上，transform 缩放归 1。
 * 解决超高像素原图（如 A7R5 61MP 9504×6336）放大再缩回时，Chromium GPU 分块缓存
 * 淘汰边缘瓦片导致四周出现黑框未渲染的问题。
 */
function lbSettleScale() {
  clearTimeout(lbSettleTimer);
  lbSettleTimer = null;
  const v = lbView;
  if (!v || lbDrag || lbPinch || lbTouch || lbGesture) return;
  const target = Math.min(1, v.scale);
  if (Math.abs(target - (v.renderScale || 1)) < 0.005) return;
  v.renderScale = target;
  const img = v.img;
  img.style.transition = 'none';
  img.style.width = (v.nw * target) + 'px';
  img.style.height = (v.nh * target) + 'px';
  lbSyncPeakBox();
  lbApply();
  void img.offsetWidth; // 强制在恢复 transition 前提交新布局尺寸，避免跳变
  requestAnimationFrame(() => {
    if (lbView && lbView.img === img) img.style.transition = '';
    const pk = $('#lbPeakCanvas');
    if (pk) pk.style.transition = '';
  });
}
function lbScheduleSettle(delayMs = 220) {
  clearTimeout(lbSettleTimer);
  lbSettleTimer = setTimeout(lbSettleScale, delayMs);
}

/** 拖拽/滚轮/捏合进行中：关掉过渡，保证 1:1 跟手；停手 220ms 后恢复 */
function lbLive() {
  const img = lbView && lbView.img;
  if (!img) return;
  img.style.transition = 'none';
  const pk = $('#lbPeakCanvas');
  if (pk) pk.style.transition = 'none';
  clearTimeout(lbAnimTimer);
  lbAnimTimer = setTimeout(() => {
    if (lbView) lbView.img.style.transition = '';
    const pk2 = $('#lbPeakCanvas');
    if (pk2) pk2.style.transition = '';
  }, 220);
}

function lbApply() {
  if (!lbView) return;
  const v = lbView;
  const rs = v.renderScale || 1;
  const s = v.scale / rs;
  const tf = Math.abs(s - 1) < 1e-5
    ? `translate(${v.tx}px, ${v.ty}px)`
    : `translate(${v.tx}px, ${v.ty}px) scale(${s})`;
  v.img.style.transform = tf;
  const pk = $('#lbPeakCanvas');
  if (pk) pk.style.transform = tf;
}

/**
 * 瞬时应用（不带动画）。
 * 进入全屏、窗口缩放、换图、图片加载 —— 这些是“布局变化”，绝不能有过渡，
 * 否则会看到「先铺满全屏、再缩回一点」这种跳变。
 * 只有用户点击缩放的那一次才走 CSS 过渡。
 */
function lbApplyInstant(fn) {
  const img = lbView && lbView.img;
  if (!img) { fn(); return; }
  img.style.transition = 'none';
  const pk = $('#lbPeakCanvas');
  if (pk) pk.style.transition = 'none';
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (lbView && lbView.img === img) img.style.transition = '';
    const pk2 = $('#lbPeakCanvas');
    if (pk2) pk2.style.transition = '';
  }));
}

/** 同一帧内多次缩放只应用一次，避免抖动 */
function lbScheduleApply() {
  if (lbApplyQueued) return;
  lbApplyQueued = true;
  requestAnimationFrame(() => { lbApplyQueued = false; lbApply(); });
}

/** 限制在画布内：比画布小就居中，比画布大就不让露出空白 */
function lbClamp() {
  const v = lbView, c = lbCanvas();
  if (!v || !c) return;
  const w = v.nw * v.scale, h = v.nh * v.scale;
  const cw = c.clientWidth, ch = c.clientHeight;
  v.tx = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, v.tx));
  v.ty = h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, v.ty));
}

/** 以画布内坐标 (px,py) 为锚点缩放到 scale —— 锚点下的像素保持不动 */
function lbZoomTo(scale, px, py) {
  const v = lbView;
  if (!v) return;
  const fit = lbFitScale();
  const ns = Math.max(fit, Math.min(LB_MAX_ZOOM, scale));
  if (Math.abs(ns - v.scale) < 1e-5) return;
  const ix = (px - v.tx) / v.scale;     // 锚点对应的原图像素坐标
  const iy = (py - v.ty) / v.scale;
  v.scale = ns;
  v.tx = px - ix * ns;
  v.ty = py - iy * ns;
  v.atFit = ns <= fit + 1e-4;
  lbClamp();
  lbScheduleApply();
  lbScheduleSettle(220);
  $('#lbStage').classList.toggle('zoomed', ns > fit + 1e-4 || lbHasOverflow());
}

/** 初始化（图片 load 后调用）：按“适应屏幕”摆放 */
function lbReset(img) {
  if (!img || !img.naturalWidth) return;
  clearTimeout(lbSettleTimer);
  lbSettleTimer = null;
  img.style.position = 'absolute';
  img.style.left = '0';
  img.style.top = '0';
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.transformOrigin = '0 0';
  img.style.touchAction = 'none';
  img.style.transition = 'none';
  lbView = { img, nw: img.naturalWidth, nh: img.naturalHeight, scale: 1, renderScale: 1, tx: 0, ty: 0, atFit: true };
  lbView.scale = lbFitScale();
  // 按实际显示倍率设布局宽高（<= 1），避免 61MP 原图在适应屏幕时创建超大 GPU 分块合成层
  lbView.renderScale = Math.min(1, lbView.scale);
  img.style.width = (lbView.nw * lbView.renderScale) + 'px';
  img.style.height = (lbView.nh * lbView.renderScale) + 'px';
  lbClamp();
  lbSyncPeakBox();
  lbApply();
  img.style.visibility = '';      // 尺寸就位后再显形，避免闪一下再缩
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (lbView && lbView.img === img) img.style.transition = '';
    const pk = $('#lbPeakCanvas');
    if (pk) pk.style.transition = '';
  }));
  $('#lbStage').classList.toggle('zoomed', lbHasOverflow());   // 填充模式铺满时也允许拖动
}

// ---------------- 鼠标：拖拽平移 / 点击切换 ----------------
let lbDrag = null;

$('#lbStage').addEventListener('pointerdown', (e) => {
  if (lbLoading) return;
  const v = lbView;
  if (!v || e.button !== 0) return;
  if (e.target.closest('button')) return;            // 别拦上一张/下一张/全屏按钮
  // 只要放大了，按在画布任意位置都能拖（图片四周的空白也算），
  // 否则拖到边界后手指落在空白处就拖不动、松手还会被当成“点背景”
  if (!lbHasOverflow()) return;      // 画面没溢出就不用拖
  // 注意：这里不能 preventDefault()，否则部分浏览器会连带抑制 click / dblclick，
  // 导致“点一下缩小”“双击关闭”失效。防原生拖图交给 dragstart + user-select:none
  lbDrag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, moved: 0 };
  $('#lbStage').classList.add('dragging');
  try { $('#lbStage').setPointerCapture(e.pointerId); } catch {}
});

$('#lbStage').addEventListener('pointermove', (e) => {
  if (!lbDrag || !lbView) return;
  const dx = e.clientX - lbDrag.x;
  const dy = e.clientY - lbDrag.y;
  lbDrag.moved = Math.max(lbDrag.moved, Math.hypot(dx, dy));
  lbView.tx = lbDrag.tx + dx;
  lbView.ty = lbDrag.ty + dy;
  lbClamp();
  lbLive();
  lbScheduleApply();
});

function lbEndDrag() {
  if (!lbDrag) return;
  if (lbDrag.moved > 4) lbLastDragAt = Date.now();   // 拖过 → 接下来 350ms 内的 click 一律忽略
  lbDrag = null;
  $('#lbStage').classList.remove('dragging');
}
$('#lbStage').addEventListener('pointerup', lbEndDrag);
$('#lbStage').addEventListener('pointercancel', lbEndDrag);
$('#lbStage').addEventListener('dragstart', (e) => e.preventDefault());

// ---------------- 滚轮 / 触控板捏合 ----------------
$('#lbStage').addEventListener('wheel', (e) => {
  if (lbLoading) return;
  const v = lbView;
  if (!v || e.target.closest('img') !== v.img) return;
  const c = lbCanvas().getBoundingClientRect();
  const px = e.clientX - c.left;
  const py = e.clientY - c.top;
  const fit = lbFitScale();

  // macOS 触控板“捏合”在浏览器里就是 wheel + ctrlKey —— 原生就是这个映射
  // 这里接管它，阻止浏览器缩放整个页面，改成缩放照片
  if (e.ctrlKey) {
    e.preventDefault();
    lbLive();
    lbZoomTo(v.scale * Math.exp(-e.deltaY * 0.01), px, py);
    return;
  }

  // Mac 上：鼠标滚轮（大 deltaY、无横向）当缩放；触控板双指滑动当平移
  const mouseWheel = Math.abs(e.deltaY) >= 40 && Math.abs(e.deltaX) < 1;
  if (IS_MAC && !mouseWheel) {
    if (v.scale > fit + 1e-4) {          // 已放大 → 双指滑动平移（原生手感）
      e.preventDefault();
      v.tx -= e.deltaX;
      v.ty -= e.deltaY;
      lbClamp();
      lbLive();
      lbScheduleApply();
    } else {
      e.preventDefault();                // 未放大 → 双指滑动不做缩放（捏合才是缩放）
    }
    return;
  }

  // Windows / Mac 鼠标滚轮：缩放
  e.preventDefault();
  lbLive();
  lbZoomTo(v.scale * Math.exp(-e.deltaY * 0.0016), px, py);
}, { passive: false });

// Safari 私有 gesture 事件（Safari 的触控板捏合有时不走 wheel+ctrlKey）
let lbGesture = null;
$('#lbStage').addEventListener('gesturestart', (e) => {
  if (!lbView) return;
  e.preventDefault();
  const c = lbCanvas().getBoundingClientRect();
  lbGesture = { scale: lbView.scale, px: e.clientX - c.left, py: e.clientY - c.top };
});
$('#lbStage').addEventListener('gesturechange', (e) => {
  if (!lbGesture) return;
  e.preventDefault();
  lbZoomTo(lbGesture.scale * e.scale, lbGesture.px, lbGesture.py);
});
$('#lbStage').addEventListener('gestureend', (e) => { e.preventDefault(); lbGesture = null; lbScheduleSettle(180); });

// ---------------- 点击：放大 / 缩小；放大后双击关闭 ----------------
// 关键：不用延时区分单击/双击，改用 e.detail（click 的点击计数）
//   detail === 1 → 单击，立即执行
//   detail >= 2  → 双击的第二下，忽略（交给 dblclick 处理）
// 这样“单击缩小”是瞬时的，同时双击也不会闪一下缩小再放大
let lbZoomedBeforeDbl = false;   // 双击序列开始前是不是放大状态

$('#lbStage').addEventListener('click', (e) => {
  if (lbLoading) return;
  if (lbJustDragged()) return;
  if (e.target.closest('button')) return;
  const v = lbView;
  if (!v) return;
  if (lbPinch) return;

  const c = lbCanvas().getBoundingClientRect();
  const fit = lbFitScale();
  const zoomed = v.scale > fit + 1e-4;
  if (e.detail === 1) lbZoomedBeforeDbl = zoomed;   // 记录本轮点击的起始状态
  if (e.detail > 1) return;                          // 双击第二下：什么都不做

  if (zoomed) {
    lbZoomTo(fit, c.width / 2, c.height / 2);        // 立即缩小
  } else {
    // 适应屏幕 → 1:1：只有点在图片上才有意义
    if (e.target.closest('img') !== v.img) return;
    lbZoomTo(1, e.clientX - c.left, e.clientY - c.top);
  }
});

// 双击：放大状态下关闭大图
$('#lbStage').addEventListener('dblclick', (e) => {
  if (lbLoading) return;
  if (e.target.closest('button')) return;
  if (!lbZoomedBeforeDbl) return;      // 在适应屏幕时双击 = 只是放大，不关闭
  e.preventDefault();
  closeLightbox();
});

// ---------------- 触屏：单指拖动 / 双指捏合 ----------------
let lbTouch = null;
let lbPinch = null;
function touchDist(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
}

$('#lbStage').addEventListener('touchstart', (e) => {
  if (lbLoading) return;
  const v = lbView;
  if (!v || e.target.closest('img') !== v.img) return;
  const c = lbCanvas().getBoundingClientRect();
  if (e.touches.length === 2) {
    lbPinch = {
      d: touchDist(e.touches),
      scale: v.scale,
      mx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - c.left,
      my: (e.touches[0].clientY + e.touches[1].clientY) / 2 - c.top,
    };
    lbTouch = null;
  } else if (e.touches.length === 1 && v.scale > lbFitScale() + 1e-4) {
    lbTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: v.tx, ty: v.ty, moved: 0 };
  }
}, { passive: true });

$('#lbStage').addEventListener('touchmove', (e) => {
  const v = lbView;
  if (!v) return;
  if (lbPinch && e.touches.length === 2) {
    e.preventDefault();
    lbLive();
    lbZoomTo(lbPinch.scale * (touchDist(e.touches) / lbPinch.d), lbPinch.mx, lbPinch.my);
  } else if (lbTouch && e.touches.length === 1) {
    const dx = e.touches[0].clientX - lbTouch.x;
    const dy = e.touches[0].clientY - lbTouch.y;
    lbTouch.moved = Math.max(lbTouch.moved, Math.hypot(dx, dy));
    v.tx = lbTouch.tx + dx;
    v.ty = lbTouch.ty + dy;
    lbClamp();
    lbLive();
    lbScheduleApply();
    if (lbTouch.moved > 6) e.preventDefault();
  }
}, { passive: false });

$('#lbStage').addEventListener('touchend', (e) => {
  if (lbPinch && e.touches.length < 2) {
    lbPinch = null;
    lbLastDragAt = Date.now();      // 捏合结束别当成点击
    lbScheduleSettle(180);
  }
  if (lbTouch && lbTouch.moved > 6) lbLastDragAt = Date.now();
  if (e.touches.length === 0) lbTouch = null;
});

// ---------------- 尺寸变化：还在“适应屏幕”就重新贴合 ----------------
// 全屏切换时画布尺寸会变（而且带过渡动画），所以用 ResizeObserver 持续跟，
// 不能只依赖 fullscreenchange —— 否则会先按旧尺寸显示一帧，再跳到新尺寸
function lbRefitIfFit() {
  if (!lbView) return;
  lbApplyInstant(() => {
    const fit = lbFitScale();
    if (lbView.atFit) lbView.scale = fit;
    else if (lbView.scale < fit) lbView.scale = fit;   // 尺寸变大后别比 fit 还小
    const rs = Math.min(1, lbView.scale);
    lbView.renderScale = rs;
    lbView.img.style.width = (lbView.nw * rs) + 'px';
    lbView.img.style.height = (lbView.nh * rs) + 'px';
    lbSyncPeakBox();
    lbClamp();
    lbApply();
  });
}
window.addEventListener('resize', () => {
  if ($('#lb').classList.contains('show')) lbRefitIfFit();
});
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => {
    if (!$('#lb').classList.contains('show') || !lbView) return;
    lbRefitIfFit();
  });
  const cv = $('#lbCanvas');
  if (cv) ro.observe(cv);
}

// 图片全屏（只留画面，侧栏隐藏；Esc 或再点一次退出）
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#lbStage').requestFullscreen();
  } catch {
    toast('这个浏览器不支持全屏');
  }
}
$('#lbFull').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });

/** 全屏按钮组：全屏时才显示“填充/完整” */
function lbSyncFillBtn() {
  const b = $('#lbFill');
  if (!b) return;
  b.style.display = lbIsFullscreen() ? '' : 'none';
  b.textContent = lbFillMode === 'fill' ? '填充' : '完整';
  b.classList.toggle('active', lbFillMode === 'fill');
}
$('#lbFill').addEventListener('click', (e) => {
  e.stopPropagation();
  lbFillMode = lbFillMode === 'fill' ? 'contain' : 'fill';
  localStorage.setItem('lbFillMode', lbFillMode);
  lbSyncFillBtn();
  lbRefitIfFit();
  const st = $('#lbStage');
  if (lbView) st.classList.toggle('zoomed', lbView.scale > lbFitScale() + 1e-4 || lbHasOverflow());
});
document.addEventListener('fullscreenchange', () => {
  const b = $('#lbFull');
  if (b) b.textContent = document.fullscreenElement ? '✕ 退出全屏' : '⛶ 全屏';
  requestAnimationFrame(() => {
    lbSyncFillBtn();
    if ($('#lb').classList.contains('show')) lbRefitIfFit();
  });
});
$('#qualitySeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  setBigQuality(b.dataset.q);
});


// 单张临时看原图：只改当前这张，不改全局偏好，翻下一页自动回到预览
$('#lbForceFull').addEventListener('click', (e) => {
  e.stopPropagation();
  const g = (window._shownGroups || [])[lbIndex];
  const jpg = g && g.items.find((x) => x.kind === 'jpg');
  const img = $('#lbStage').querySelector('img');
  if (!jpg || !img) return;
  e.target.style.display = 'none';
  const nt = $('#qualityNote');
  if (nt) nt.textContent = '原图加载中…（仅本张）';
  // 换源期间也显示转圈，加载完重新贴合
  lbLoading = true;
  lbSpinner(true);
  img.addEventListener('load', async () => {
    if (!img.naturalWidth) return;
    try { if (img.decode) await img.decode(); } catch {}
    lbReset(img);
    lbSpinner(false);
    lbLoading = false;
    scheduleLbSharpness(img, g, false);
  }, { once: true });
  img.addEventListener('error', () => { lbSpinner(false); lbLoading = false; }, { once: true });
  img.src = '/api/media?rel=' + enc(jpg.rel);
});
$('#lbClose').addEventListener('click', () => closeLightbox());
// 点背景关闭。两个保护：
//  1) 刚拖拽过 → 无视（pointer capture 会把 click 目标变成 .stage，一拖就误关）
//  2) 已放大时不靠点背景关闭 —— 放大后画布大片空白，极易误触，要关请用 Esc / ✕ / 后退键
$('#lb').addEventListener('click', (e) => {
  if (lbJustDragged()) return;
  const t = e.target;
  const isBg = t.id === 'lb' || t.id === 'lbCanvas' || (t.classList && t.classList.contains('stage'));
  if (!isBg) return;
  // 关键：不能看“现在的 scale” —— click 会先冒泡到 #lbStage 把图缩回适应屏幕，
  // 等冒到 #lb 时 scale 已经是 fit 了，于是会误关。要看“点击发生时是不是放大状态”。
  if (lbZoomedBeforeDbl) return;
  if (lbView && lbView.scale > lbFitScale() + 1e-4) return;
  closeLightbox();
});
$('#lbOpen').addEventListener('click', () => {
  const groups = window._shownGroups || []; const g = groups[lbIndex]; if (!g) return;
  fetch('/api/reveal?rel=' + enc(g.main.rel)).then(() => toast(`已在${fileManagerName()}中定位`));
});
$('#lbFavBadge').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCurrentFavorite();
});

