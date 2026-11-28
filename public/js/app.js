/**
 * 应用核心：工具函数、全局状态、服务端轮询、总览与文件夹网格渲染、路由历史
 */
'use strict';

// ---------------------------------------------------------------- 工具
const $ = (s) => document.querySelector(s);
const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B','KiB','MiB','GiB','TiB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
};
const fmtNum = (n) => (n || 0).toLocaleString('en-US');
const enc = encodeURIComponent;
const KIND_LABEL = { raw: 'RAW', jpg: 'JPG', video: '视频', heif: 'HEIF', other: '其它' };
const kindClass = (k) => k === 'raw' ? 'raw' : k === 'video' ? 'video' : k === 'jpg' ? 'jpg' : k === 'heif' ? 'jpg' : 'other';
const extKind = (name) => {
  const e = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (['.rw2','.cr3','.cr2','.arw','.orf','.nef','.dng','.raf','.rwl','.pef','.srw','.raw'].includes(e)) return 'raw';
  if (['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tif','.tiff','.avif'].includes(e)) return 'jpg';
  if (['.hif','.heic','.heif'].includes(e)) return 'heif';
  if (['.mov','.mp4','.avi','.m4v','.mkv','.mts','.m2ts','.3gp','.wmv'].includes(e)) return 'video';
  return 'other';
};
function toast(msg) {
  const t = $('#toast');
  const fsEl = document.fullscreenElement;
  if (fsEl && t.parentElement !== fsEl) fsEl.appendChild(t);
  else if (!fsEl && t.parentElement !== document.body) document.body.appendChild(t);
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- 状态
const FAV_FOLDER_REL = '__favorites__';
const baseOfRel = (rel) => {
  const s = String(rel || '').replace(/\\/g, '/');
  const slash = s.lastIndexOf('/');
  const dot = s.lastIndexOf('.');
  return dot > slash ? s.slice(0, dot) : s;
};
let STATE = { folders: [], totals: {}, favorites: { count: 0, files: 0, bytes: 0, bases: [] }, status: 'idle', progress: {} };
let favoriteSet = new Set();
const favPendingIntent = new Map(); // base -> { target, seq }（防连按竞态）
const aliasPendingIntent = new Map(); // folder rel -> { alias, seq }（防轮询覆盖正在保存的相册名）
let aliasIntentSeq = 0;
let favoriteAddedAt = {};
let favDirtyInDetail = false;
const isGroupFavorited = (g) => !!(g && g.base && favoriteSet.has(g.base));
const normalizeAlbumAlias = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
function syncAliasesFromState() {
  if (!aliasPendingIntent.size || !Array.isArray(STATE.folders)) return;
  for (const f of STATE.folders) {
    const intent = aliasPendingIntent.get(f.rel);
    if (intent) f.alias = intent.alias;
  }
}
function syncFavoritesFromState(fav) {
  const next = new Set((fav && Array.isArray(fav.bases)) ? fav.bases : []);
  // 保留正在飞的切换请求意图，防止旧轮询回写抖动
  for (const [b, intent] of favPendingIntent.entries()) {
    if (intent.target) next.add(b);
    else next.delete(b);
  }
  favoriteSet = next;
}
let sortKey = 'date', collapsedYears = new Set(), filter = 'all';
let cameraOnly = localStorage.getItem('cameraOnly') === '1';
// 识别手机 EXIF 机型（排除手机拍照，但保留 SONY ILCE/ZV/DSC、SAMSUNG NX 等专业相机）
const PHONE_CAM_RE = /\b(apple|iphone|ipad|vivo|oppo|oneplus|xiaomi|redmi|poco|huawei|honor|galaxy|pixel|google|meizu|realme|iqoo|nubia|zte|motorola|moto\s|lenovo|zenfone|rog\s*phone|nothing\s*phone|smartisan|htc|nokia|blackberry|tecno|infinix|transsion|xperia)\b|\b(sm-|gt-|shv-|sgh-|sch-|xq-|so-|sov|sog)\w|\bsamsung\s+(?!nx|ex|wb|gx|st|mv|pl|es|dv)/i;
// 相机专属 RAW 扩展名（不含 .dng，避免把手机 DNG 误判为相机）
const CAMERA_RAW_EXTS = ['.arw', '.cr3', '.cr2', '.nef', '.rw2', '.raf', '.orf', '.pef', '.srw', '.rwl'];
function isCameraFolder(f) {
  const cams = (f && f.exif && f.exif.cameras) || [];
  if (cams.some((c) => c && c.name && !PHONE_CAM_RE.test(c.name))) return true;
  if (!cams.length && f && f.exts) {
    return CAMERA_RAW_EXTS.some((ext) => f.exts[ext] && f.exts[ext].n > 0);
  }
  return false;
}
let currentFolder = null, currentFiles = [], currentGroups = [], lbIndex = -1;
// EXIF 是异步的：每次开灯箱递增一次，回调里比对，丢弃过期结果
let lbExifToken = 0;
const lbExifCache = new Map();
let lbPrefetchTimer = null;
let lbPrefetchImgs = [];
let gridIO = null;              // 网格的懒加载观察器
let gridWant = new Set();       // 当前想看（在视口附近）的卡片
let gridActive = new Set();     // 正在下载的卡片
const GRID_CONCURRENCY = 6;     // 浏览器每域默认也是 6，再多也没用
let thumbWorkPaused = false;    // 是否因为播视频而暂停了缩略图生成
let pauseHeartbeat = null;      // 播视频期间给服务端续期（服务端暂停只保留 30s）
let pendingNav = parseNav();
function parseNav() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { folder: null, photo: null };
  const q = new URLSearchParams(raw);
  return { folder: q.get('folder'), photo: q.get('p') };
}
const hashFor = (folder, photo) => '#folder=' + enc(folder) + (photo ? '&p=' + enc(photo) : '');
let thumbMode = localStorage.getItem('thumbMode') || 'off';   // off | auto

function setThumbMode(m) {
  thumbMode = m;
  localStorage.setItem('thumbMode', m);
  for (const id of ['#thumbSeg', '#thumbSeg2']) {
    const seg = $(id); if (!seg) continue;
    [...seg.children].forEach((b) => b.classList.toggle('active', b.dataset.t === m));
  }
  render();
  if (currentFolder) renderGrid();
}
for (const id of ['#thumbSeg', '#thumbSeg2']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setThumbMode(b.dataset.t);
  });
}

// ---- 缩略图尺寸档位
let thumbSize = localStorage.getItem('thumbSize') || 'l';   // s | m | l | xl

// 大图画质：preview = 服务端 2048px 预览；full = 原图直出
// 默认：本机用原图，局域网/手机用预览（否则一张 52MB 的图要等很久）
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname || 'localhost');
let bigQuality = localStorage.getItem('bigQuality') || (IS_LOCAL ? 'full' : 'preview');
function setBigQuality(q) {
  bigQuality = q === 'full' ? 'full' : 'preview';
  localStorage.setItem('bigQuality', bigQuality);
  if ($('#lb').classList.contains('show') && lbIndex >= 0) openLightbox(lbIndex, { mode: 'none' });
}
const SIZE_CLASS = { s: 'sz-s', m: 'sz-m', l: 'sz-l', xl: 'sz-xl' };
function setThumbSize(s) {
  thumbSize = SIZE_CLASS[s] ? s : 'l';
  localStorage.setItem('thumbSize', thumbSize);
  document.body.classList.remove('sz-s', 'sz-m', 'sz-l', 'sz-xl');
  document.body.classList.add(SIZE_CLASS[thumbSize]);
  for (const id of ['#sizeSeg', '#sizeSeg2']) {
    const seg = $(id); if (!seg) continue;
    [...seg.children].forEach((b) => b.classList.toggle('active', b.dataset.s === thumbSize));
  }
}
for (const id of ['#sizeSeg', '#sizeSeg2']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setThumbSize(b.dataset.s);
  });
}

// ---------------------------------------------------------------- 拉取状态
async function pull() {
  try {
    const r = await fetch('/api/state');
    STATE = await r.json();
    syncFavoritesFromState(STATE.favorites);
    syncAliasesFromState();
    if (currentFolder && !currentFolder.isFavorites) {
      const freshFolder = STATE.folders.find((x) => x.rel === currentFolder.rel);
      if (freshFolder) currentFolder = freshFolder;
      syncDetailAliasInput();
    }
    renderHeader();
    render();
    // 首次加载时带 #folder=... 的地址（刷新/分享），数据到了再打开
    if (pendingNav && pendingNav.folder && (pendingNav.folder === FAV_FOLDER_REL || STATE.folders.some((f) => f.rel === pendingNav.folder))) {
      const nav = pendingNav; pendingNav = null;
      // 先把当前那条历史记成"总览页"，再 push 一个文件夹条目，这样后退是回总览而不是离开网站
      history.replaceState(null, '', location.pathname + location.search);
      openFolder(nav.folder, { push: true, photo: nav.photo });
    }
    if (STATE.status === 'scanning') setTimeout(pull, 400);
  } catch (e) {
    setTimeout(pull, 1500);
  }
}

function fileManagerName() {
  if (STATE.platform === 'darwin') return '访达';
  if (STATE.platform === 'win32') return '资源管理器';
  return '文件管理器';
}
const escHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderHeader() {
  const t = STATE.totals || {};
  const rp = $('#rootPath');
  if (STATE.root) {
    rp.textContent = '📂 ' + STATE.root;
    rp.classList.remove('unset');
    rp.title = STATE.root + '（点击切换目录）';
    const base = STATE.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || STATE.root;
    document.title = `照片库总览 · ${base}`;
  } else {
    rp.textContent = '📂 点击选择照片库目录…';
    rp.classList.add('unset');
    rp.title = '尚未设置照片库目录，点击选择';
    document.title = '照片库总览';
  }
  const openBtn = $('#btnOpenFolder');
  if (openBtn) openBtn.textContent = `📂 在${fileManagerName()}中打开`;
  const lanEl = $('#lanUrl');
  if (lanEl) {
    const lan = (STATE.urls || []).find((u) => /^http:\/\/(?!127\.|localhost)/.test(u));
    if (lan) { lanEl.textContent = '局域网 ' + lan.replace('http://', ''); lanEl.dataset.url = lan; lanEl.style.display = ''; }
    else lanEl.style.display = 'none';
  }
  const showHdrActions = !!(STATE.root && STATE.status !== 'error');
  const hdrSearch = $('#hdrSearch');
  if (hdrSearch) hdrSearch.style.display = showHdrActions ? '' : 'none';
  const camBtn = $('#btnCamOnly');
  if (camBtn) {
    camBtn.style.display = showHdrActions ? '' : 'none';
    if (showHdrActions) {
      const camCnt = (STATE.folders || []).filter(isCameraFolder).length;
      camBtn.classList.toggle('active', cameraOnly);
      camBtn.setAttribute('aria-pressed', cameraOnly ? 'true' : 'false');
      const cntEl = $('#hdrCamCount');
      if (cntEl) cntEl.textContent = fmtNum(camCnt);
      camBtn.title = cameraOnly
        ? `当前仅显示相机拍摄的文件夹（${fmtNum(camCnt)} 个），点击恢复显示全部`
        : `仅显示相机拍摄的文件夹（共 ${fmtNum(camCnt)} 个，自动过滤手机照片与纯视频）`;
    }
  }
  const favBtn = $('#btnFavAlbum');
  if (favBtn) {
    favBtn.style.display = showHdrActions ? '' : 'none';
    if (showHdrActions) {
      const fav = STATE.favorites || { count: 0, files: 0, bytes: 0 };
      const cnt = fav.count || 0;
      favBtn.classList.toggle('has-items', cnt > 0);
      const cntEl = $('#hdrFavCount');
      if (cntEl) cntEl.textContent = fmtNum(cnt);
      favBtn.title = cnt > 0
        ? `查看收藏相册（${fmtNum(cnt)} 张 · ${fmtNum(fav.files || cnt)} 个文件 · ${fmtSize(fav.bytes || 0)}）`
        : '收藏相册（还没有收藏照片，在大图按 D 键可收藏）';
    }
  }
  $('#tFolders').textContent = fmtNum(t.folders);
  $('#tFiles').textContent = fmtNum(t.files);
  $('#tSize').textContent = fmtSize(t.bytes);
  const scanning = STATE.status === 'scanning';
  $('#progBar').style.display = scanning ? 'block' : 'none';
  $('#scanLine').style.display = scanning ? 'flex' : 'none';
  if (scanning) {
    const p = STATE.progress || {};
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('#progBar').firstElementChild.style.width = pct + '%';
    $('#scanText').textContent = `正在扫描 ${p.done}/${p.total} 个文件夹… ${p.current || ''}（已发现 ${fmtSize(p.bytes)}）`;
    $('#tTime').textContent = '扫描中';
  } else {
    $('#tTime').textContent = STATE.elapsedMs ? (STATE.elapsedMs / 1000).toFixed(1) + 's' : '–';
  }
}

// ---------------------------------------------------------------- 总览搜索（日期 / 文件夹名称 / 自定义相册名 / 相机）
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTsDate(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDateVariants(set, y, m, d) {
  const yy = String(y);
  const mm = pad2(m);
  const dd = pad2(d);
  set.add(`${yy}-${mm}-${dd}`);
  set.add(`${yy}${mm}${dd}`);
  set.add(`${yy}年${Number(m)}月${Number(d)}日`);
  set.add(`${yy}年${mm}月${dd}日`);
}
function extractFolderDates(f) {
  const dates = new Set();
  const addFromText = (txt) => {
    if (!txt) return false;
    let found = false;
    const s = String(txt);
    for (const m of s.matchAll(/\b((?:19|20)\d{2})[-./_](\d{1,2})[-./_](\d{1,2})\b/g)) {
      const mo = +m[2], dy = +m[3];
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        addDateVariants(dates, m[1], mo, dy);
        found = true;
      }
    }
    for (const m of s.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(\d{2})(\d{2})(?:[^\d]|$)/g)) {
      const mo = +m[2], dy = +m[3];
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        addDateVariants(dates, m[1], mo, dy);
        found = true;
      }
    }
    if (!found) {
      for (const m of s.matchAll(/\b((?:19|20)\d{2})[-./_](\d{1,2})\b/g)) {
        const mo = +m[2];
        if (mo >= 1 && mo <= 12) {
          const mm = pad2(mo);
          dates.add(`${m[1]}-${mm}`);
          dates.add(`${m[1]}${mm}`);
          dates.add(`${m[1]}年${mo}月`);
          dates.add(`${m[1]}年${mm}月`);
          found = true;
        }
      }
    }
    return found;
  };
  const hasNameDate = addFromText(f.name);
  const sampDate = f && f.exif && f.exif.sample && f.exif.sample.date;
  const hasExifDate = addFromText(sampDate);
  if (!hasNameDate && !hasExifDate) {
    if (f.tMin) addFromText(fmtTsDate(f.tMin));
    if (f.tMax && f.tMax !== f.tMin) addFromText(fmtTsDate(f.tMax));
  }
  return [...dates].join(' ');
}
function normalizeDateQueryToken(tok) {
  let m;
  if ((m = /^((?:19|20)\d{2})(?:[-./]|年)(\d{1,2})(?:[-./]|月)(\d{1,2})[日号]?$/.exec(tok))) {
    const mo = +m[2], dy = +m[3];
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return `${m[1]}-${pad2(mo)}-${pad2(dy)}`;
  }
  if ((m = /^((?:19|20)\d{2})(?:[-./]|年)(\d{1,2})月?$/.exec(tok))) {
    const mo = +m[2];
    if (mo >= 1 && mo <= 12) return `${m[1]}-${pad2(mo)}`;
  }
  if ((m = /^((?:19|20)\d{2})年$/.exec(tok))) {
    return m[1];
  }
  if ((m = /^(\d{1,2})(?:[-./]|月)(\d{1,2})[日号]?$/.exec(tok))) {
    const mo = +m[1], dy = +m[2];
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return `-${pad2(mo)}-${pad2(dy)}`;
  }
  if ((m = /^(\d{1,2})月$/.exec(tok))) {
    const mo = +m[1];
    if (mo >= 1 && mo <= 12) return `-${pad2(mo)}-`;
  }
  return '';
}
function parseSearchTokens(rawQ) {
  return String(rawQ || '').trim().toLowerCase().split(/\s+/).filter(Boolean).map((raw) => ({
    raw,
    dateNorm: normalizeDateQueryToken(raw),
  }));
}
function folderMatchesQuery(f, tokens) {
  const cams = ((f.exif || {}).cameras || []).map((c) => c.name).join(' ');
  const dateStr = extractFolderDates(f);
  const hay = `${f.name || ''} ${f.alias || ''} ${cams} ${dateStr}`.toLowerCase();
  const dateHay = dateStr.toLowerCase();
  for (const { raw, dateNorm } of tokens) {
    if (hay.includes(raw)) continue;
    if (dateNorm && dateHay.includes(dateNorm)) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 总览渲染
function folderKinds(f) {
  const k = f.kinds || {};
  return {
    jpg: (k.jpg || {}).n || 0,
    raw: (k.raw || {}).n || 0,
    heif: (k.heif || {}).n || 0,
    video: (k.video || {}).n || 0,
    other: (k.other || {}).n || 0,
  };
}

function render() {
  const rawQ = ($('#q').value || '').trim();
  const tokens = parseSearchTokens(rawQ);
  const hasQ = tokens.length > 0;
  let folders = STATE.folders.slice();

  if (cameraOnly) {
    folders = folders.filter(isCameraFolder);
  }

  if (hasQ) {
    folders = folders.filter((f) => folderMatchesQuery(f, tokens));
  }

  const hdrSearch = $('#hdrSearch');
  if (hdrSearch) {
    hdrSearch.classList.toggle('has-q', hasQ);
    hdrSearch.classList.toggle('no-hit', hasQ && folders.length === 0);
    const cntEl = $('#hdrSearchCount');
    if (cntEl) cntEl.textContent = fmtNum(folders.length);
  }

  if (sortKey === 'size') folders.sort((a, b) => b.bytes - a.bytes);
  else if (sortKey === 'files') folders.sort((a, b) => b.files - a.files);
  else if (sortKey === 'dateUp') folders.sort((a, b) => a.name.localeCompare(b.name));
  else folders.sort((a, b) => b.name.localeCompare(a.name));

  const maxBytes = Math.max(1, ...STATE.folders.map((f) => f.bytes));

  // 按年分组（仅在按日期排序时分组）
  const groups = new Map();
  for (const f of folders) {
    let key;
    if (sortKey === 'size' || sortKey === 'files') key = '';
    else {
      const m = /^(\d{4})/.exec(f.name);
      key = m ? m[1] : '其它';
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const html = [];
  for (const [year, list] of groups) {
    const sum = list.reduce((a, f) => a + f.bytes, 0);
    const n = list.reduce((a, f) => a + f.files, 0);
    if (year) {
      const coll = !hasQ && collapsedYears.has(year);
      html.push(`<section class="year ${coll ? 'collapsed' : ''}" data-year="${year}">
        <div class="year-h"><span class="chev">▼</span><h2>${year}</h2>
        <span class="sum">${list.length} 个文件夹 · ${fmtNum(n)} 个文件 · ${fmtSize(sum)}</span></div>
        <div class="rows">`);
    } else {
      html.push(`<section class="year"><div class="rows">`);
    }
    for (const f of list) {
      const k = folderKinds(f);
      const badges = [];
      if (k.jpg) badges.push(`<span class="badge jpg">JPG ${fmtNum(k.jpg)}</span>`);
      if (k.raw) badges.push(`<span class="badge raw">RAW ${fmtNum(k.raw)}</span>`);
      if (k.heif) badges.push(`<span class="badge jpg">HEIF ${fmtNum(k.heif)}</span>`);
      if (k.video) badges.push(`<span class="badge video">视频 ${fmtNum(k.video)}</span>`);
      if (k.other) badges.push(`<span class="badge other">其它 ${fmtNum(k.other)}</span>`);
      const cam = ((f.exif || {}).cameras || [])[0];
      const samp = (f.exif || {}).sample || {};
      const sub = f.subdirs && f.subdirs.length ? `${f.subdirs.length} 个子文件夹` : '';
      const cover = (thumbMode === 'auto' && f.cover)
        ? `<div class="coverwrap"><img class="cover" loading="lazy" src="/api/prev?rel=${enc(f.cover)}" alt="">` +
          (f.coverKind === 'video' ? '<span class="vbadge">▶</span>' : '') + '</div>'
        : `<div class="cover ph"><b>${f.name.slice(0, 4)}</b>${f.name.slice(5) || '&nbsp;'}</div>`;
      const alias = f.alias || '';
      const nameHtml = `<div class="name-line${alias ? ' has-alias' : ''}">` +
        `<span class="fname" title="${escHtml(f.name)}">${escHtml(f.name)}</span>` +
        (alias ? `<span class="alias" title="${escHtml(alias)}">${escHtml(alias)}</span>` : '') +
        `</div>`;
      html.push(`<div class="row" data-rel="${f.rel.replace(/"/g, '&quot;')}">
        ${cover}
        <div class="name">${nameHtml}${sub ? `<small>${sub}</small>` : ''}</div>
        <div class="size"><b>${fmtSize(f.bytes)}</b>
          <div class="minibar"><i style="width:${Math.max(2, (f.bytes / maxBytes) * 100)}%"></i></div></div>
        <div class="num">${fmtNum(f.files)} 文件</div>
        <div class="num">${fmtNum(k.jpg + k.raw + k.heif)} 张照片</div>
        <div class="badges">${badges.join('')}</div>
        <div class="row-foot">
          <div class="cam">${cam ? cam.name : '<span style="color:var(--fg3)">—</span>'}
            ${samp.date ? `<small>${samp.date.slice(0, 10)}</small>` : ''}</div>
          <button class="open" title="在${fileManagerName()}中打开"><span class="open-ico" aria-hidden="true">📂</span>打开</button>
        </div>
      </div>`);
    }
    html.push(`</div></section>`);
  }

  if (!STATE.root) {
    html.length = 0;
    html.push(`<div class="empty-card">
      <p>还没有指定照片库目录。<br>点击下方按钮选择本机文件夹或外接硬盘目录即可开始扫描。</p>
      <button class="btn-primary" id="btnPickEmpty">📂 选择照片库目录</button>
    </div>`);
  } else if (STATE.status === 'error') {
    html.length = 0;
    html.push(`<div class="empty-card">
      <p>当前目录无法读取：</p>
      <p class="errtxt">${escHtml(STATE.error || '未知错误')}</p>
      <button class="btn-primary" id="btnPickEmpty">📂 切换其他目录</button>
    </div>`);
  } else if (!folders.length) {
    const emptyText = STATE.status === 'scanning'
      ? '扫描中…'
      : (hasQ
        ? `没有匹配「${escHtml(rawQ)}」的文件夹` + (cameraOnly ? '（当前已开启「仅看相机」）' : '')
        : '没有匹配的文件夹');
    html.push(`<div class="empty">${emptyText}</div>`);
  }
  $('#overview').innerHTML = html.join('');
  const hintParts = [`共 ${fmtNum(STATE.folders.length)} 个文件夹`];
  if (cameraOnly && hasQ) hintParts.push('仅相机', `匹配 ${fmtNum(folders.length)}`);
  else if (cameraOnly) hintParts.push(`仅相机 ${fmtNum(folders.length)}`);
  else if (hasQ) hintParts.push(`匹配 ${fmtNum(folders.length)}`);
  $('#hintText').textContent = hintParts.join(' · ');
}

// 事件委托：总览
$('#btnCamOnly').addEventListener('click', () => {
  cameraOnly = !cameraOnly;
  try { localStorage.setItem('cameraOnly', cameraOnly ? '1' : '0'); } catch {}
  renderHeader();
  render();
});
$('#btnFavAlbum').addEventListener('click', () => openFolder(FAV_FOLDER_REL));
$('#overview').addEventListener('click', (e) => {
  if (e.target.closest('#btnPickEmpty')) { openRootModal(); return; }
  const yh = e.target.closest('.year-h');
  if (yh) {
    const y = yh.parentElement.dataset.year;
    if (y) {
      collapsedYears.has(y) ? collapsedYears.delete(y) : collapsedYears.add(y);
      yh.parentElement.classList.toggle('collapsed');
    }
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  if (e.target.closest('.open')) {
    e.stopPropagation();
    fetch('/api/reveal?rel=' + enc(row.dataset.rel)).then(() => toast(`已在${fileManagerName()}中打开`));
    return;
  }
  openFolder(row.dataset.rel);
});

let qTimer = null;
const qInput = $('#q');
function applySearchNow() {
  clearTimeout(qTimer);
  render();
  if (window.scrollY > 0) window.scrollTo(0, 0);
}
qInput.addEventListener('input', () => {
  clearTimeout(qTimer);
  const hs = $('#hdrSearch');
  if (hs) hs.classList.toggle('has-q', !!qInput.value.trim());
  qTimer = setTimeout(() => {
    render();
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, 100);
});
qInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (qInput.value) {
      qInput.value = '';
      applySearchNow();
    } else {
      qInput.blur();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    applySearchNow();
  }
});
$('#btnClearQ').addEventListener('click', () => {
  qInput.value = '';
  applySearchNow();
  qInput.focus();
});
$('#lanUrl').addEventListener('click', async () => {
  const url = $('#lanUrl').dataset.url;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('已复制：' + url); }
  catch { toast(url); }
});
$('#sortSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sortKey = b.dataset.sort;
  [...$('#sortSeg').children].forEach((x) => x.classList.toggle('active', x === b));
  render();
});
$('#btnRescan').addEventListener('click', async () => {
  await fetch('/api/rescan');
  toast('重新扫描中…');
  setTimeout(pull, 100);
});

$('#btnCache').addEventListener('click', async () => {
  const s = await (await fetch('/api/cache/stats')).json();
  const msg = `缩略图缓存：${fmtNum(s.files)} 个文件，${fmtSize(s.bytes)}\n索引缓存：${fmtSize(s.index)}\n上限：${fmtSize(s.cap)}\n\n确定清空缩略图缓存吗？（下次浏览会重新生成）`;
  if (!confirm(msg)) return;
  await fetch('/api/cache/clear');
  toast('缩略图缓存已清空');
});

// ---------------------------------------------------------------- 文件夹详情
function updateFavoritesDetailMeta() {
  if (!currentFolder || !currentFolder.isFavorites) return;
  let bytes = 0, rawN = 0, photoN = 0, videoN = 0;
  for (const [rel, size] of currentFiles) {
    bytes += size;
    const k = extKind(rel);
    if (k === 'raw') rawN++;
    if (k === 'jpg' || k === 'raw' || k === 'heif') photoN++;
    if (k === 'video') videoN++;
  }
  $('#dMeta').innerHTML = [
    `<span>已收藏 <b>${fmtNum(currentGroups.length)}</b> 项</span>`,
    `<span>文件 <b>${fmtNum(currentFiles.length)}</b></span>`,
    `<span>总大小 <b>${fmtSize(bytes)}</b></span>`,
    photoN ? `<span>照片文件 <b>${fmtNum(photoN)}</b>${rawN ? `（RAW ${fmtNum(rawN)}）` : ''}</span>` : '',
    videoN ? `<span>视频 <b>${fmtNum(videoN)}</b></span>` : '',
  ].filter(Boolean).join('');
}

function refreshFavoritesDetailFromLocal() {
  if (!currentFolder || !currentFolder.isFavorites) return;
  currentFiles = currentFiles.filter(([r]) => favoriteSet.has(baseOfRel(r)) && !pendingDeleteRels.has(r));
  currentGroups = groupFiles(currentFiles);
  updateFavoritesDetailMeta();
  renderGrid();
}

async function openFolder(rel, opts = {}) {
  const isFav = rel === FAV_FOLDER_REL;
  const f = isFav
    ? { rel: FAV_FOLDER_REL, name: '收藏相册', isFavorites: true }
    : STATE.folders.find((x) => x.rel === rel);
  if (!f) return;
  currentFolder = f;
  favDirtyInDetail = false;
  $('#detail').classList.add('show');
  // 写入历史记录：浏览器的后退键就能退回总览
  if (opts.push !== false) {
    const hash = hashFor(rel);
    if (location.hash !== hash) history.pushState({ folder: rel }, '', hash);
  }
  const openBtn = $('#btnOpenFolder');
  if (openBtn) openBtn.style.display = isFav ? 'none' : '';
  const aliasInput = $('#dAlias');
  if (aliasInput) {
    aliasInput.style.display = isFav ? 'none' : '';
    aliasInput.value = isFav ? '' : (f.alias || '');
    aliasInput.classList.toggle('has-val', !isFav && !!f.alias);
  }
  $('#dTitle').textContent = isFav ? '★ 收藏相册' : f.name;
  if (isFav) {
    $('#dMeta').innerHTML = '<span>读取收藏中…</span>';
    $('#dSubs').innerHTML = '';
  } else {
    const k = folderKinds(f);
    const samp = (f.exif || {}).sample || {};
    const cams = ((f.exif || {}).cameras || []).map((c) => c.name).join(' / ');
    $('#dMeta').innerHTML = [
      `<span>总大小 <b>${fmtSize(f.bytes)}</b></span>`,
      `<span>文件 <b>${fmtNum(f.files)}</b></span>`,
      k.jpg + k.raw + k.heif ? `<span>照片 <b>${fmtNum(k.jpg + k.raw + k.heif)}</b>（RAW ${fmtNum(k.raw)}）</span>` : '',
      k.video ? `<span>视频 <b>${fmtNum(k.video)}</b></span>` : '',
      cams ? `<span>相机 <b>${cams}</b></span>` : '',
      samp.dims || samp.f ? `<span>规格 ${[samp.dims, samp.f, samp.shutter, samp.iso].filter(Boolean).join(' · ')}</span>` : '',
    ].filter(Boolean).join('');

    $('#dSubs').innerHTML = (f.subdirs || []).map((s) => `
      <div class="sub"><span class="n">📁 ${s.name}</span>
        <span style="color:var(--fg3);font-size:11.5px">${fmtNum(s.files)} 个文件</span>
        <span class="s">${fmtSize(s.bytes)}</span></div>`).join('');
  }

  $('#grid').innerHTML = '<div class="empty">读取中…</div>';
  const endpoint = isFav ? '/api/favorites' : ('/api/folder?rel=' + enc(rel));
  const r = await fetch(endpoint);
  const data = await r.json();
  if (!currentFolder || currentFolder.rel !== rel) return;
  if (isFav) favoriteAddedAt = data.addedAt || {};
  else if (typeof data.alias === 'string' && !aliasPendingIntent.has(rel)) {
    currentFolder.alias = data.alias;
    const stateFolder = STATE.folders.find((x) => x.rel === rel);
    if (stateFolder) stateFolder.alias = data.alias;
    syncDetailAliasInput();
  }
  currentFiles = (data.fileList || []).filter(([r2]) => !pendingDeleteRels.has(r2));
  currentGroups = groupFiles(currentFiles);
  if (isFav) updateFavoritesDetailMeta();
  renderGrid();
  // 地址里带了 &p=xxx（刷新 / 分享 / 前进后退）就直接弹出那张
  if (opts.photo) {
    const idx = findGroupIndex(opts.photo);
    if (idx >= 0) openLightbox(idx, { mode: opts.push === false ? 'none' : 'push' });
  }
}

// 把同名 JPG/RAW 配成一张卡片
function groupFiles(files) {
  const map = new Map();
  for (const [rel, size, mt] of files) {
    const base = baseOfRel(rel);
    const name = rel.split('/').pop();
    const kind = extKind(name);
    let g = map.get(base);
    if (!g) { g = { base, items: [], videos: [] }; map.set(base, g); }
    g.items.push({ rel, size, mt, kind, name, ext: (name.match(/\.[^.]+$/) || [''])[0].toUpperCase() });
    if (kind === 'video') g.videos.push(rel);
  }
  const out = [...map.values()];
  for (const g of out) {
    const pri = { raw: 3, jpg: 2, heif: 1, video: 4, other: 0 };
    g.items.sort((a, b) => pri[b.kind] - pri[a.kind]);
    g.main = g.items[0];
    g.size = g.items.reduce((a, i) => a + i.size, 0);
    g.kinds = [...new Set(g.items.map((i) => i.kind))];
    // 同名 HEIF+RAW（如佳能 HDR PQ 的 CR3+HIF）时优先用 HEIF：CR3 内嵌往往不是 JPEG
    g.preview =
      g.items.find((i) => i.kind === 'heif') ||
      g.items.find((i) => i.kind === 'raw') ||
      g.items.find((i) => i.kind === 'jpg') ||
      g.items.find((i) => i.kind === 'video') || g.items[0];
  }
  if (currentFolder && currentFolder.isFavorites) {
    out.sort((a, b) => ((favoriteAddedAt[b.base] || 0) - (favoriteAddedAt[a.base] || 0)) || a.base.localeCompare(b.base));
  } else {
    out.sort((a, b) => a.base.localeCompare(b.base));
  }
  return out;
}

function renderGrid() {
  abortGridDownloads();   // 先取消上一轮没下载完的，避免堆积
  const groups = currentGroups;
  const shown = groups.filter((g) => {
    const ks = g.kinds;
    if (filter === 'all') return true;
    if (filter === 'photo') return ks.includes('jpg') || ks.includes('raw') || ks.includes('heif');
    if (filter === 'raw') return ks.includes('raw');
    if (filter === 'video') return ks.includes('video');
    if (filter === 'other') return ks.includes('other') && !ks.some((k) => k !== 'other');
    return true;
  });
  if (!shown.length) {
    const emptyMsg = (currentFolder && currentFolder.isFavorites && !groups.length)
      ? '还没有收藏任何照片。浏览任意文件夹大图时，按 D 键或点击「收藏」按钮即可加入这里。'
      : '这里没有可显示的项目';
    $('#grid').innerHTML = `<div class="empty">${emptyMsg}</div>`;
    $('#gridHint').textContent = '';
    window._shownGroups = [];
    return;
  }
  $('#gridHint').textContent = `${shown.length} 项` + (groups.length !== shown.length ? ` / 共 ${groups.length}` : '') +
    (thumbMode === 'off' ? ' · 点击卡片加载缩略图，再点一次看大图' : ' · 点击看大图');

  const isFavView = !!(currentFolder && currentFolder.isFavorites);
  if (thumbMode === 'off') {
    $('#grid').innerHTML = shown.map((g, i) => {
      const tags = g.kinds.map((k) => `<span class="${kindClass(k)}">${KIND_LABEL[k]}</span>`).join('');
      const favMark = isGroupFavorited(g) ? '<span class="fav-mark" title="已收藏">★</span>' : '';
      const name = g.main.name.replace(/\.[^.]+$/, '');
      const titleText = escHtml((isFavView ? g.main.rel : g.main.name) + ' · ' + fmtSize(g.size) + '（点击加载缩略图）');
      return `<div class="card ph" data-i="${i}" title="${titleText}">
        <span class="e">${g.items.map((x) => x.ext.replace('.', '')).join('+')}</span>
        <span class="n">${escHtml(name)}</span>
        <span class="s">${fmtSize(g.size)}</span>
        ${favMark}
        <div class="tag">${tags}</div></div>`;
    }).join('');
    window._shownGroups = shown;
    return;
  }

  $('#grid').innerHTML = shown.map((g, i) => {
    const tags = g.kinds.map((k) => `<span class="${kindClass(k)}">${KIND_LABEL[k]}</span>`).join('');
    const favMark = isGroupFavorited(g) ? '<span class="fav-mark" title="已收藏">★</span>' : '';
    const titleText = escHtml(isFavView ? g.main.rel : g.main.name);
    return `<div class="card loading" data-i="${i}" title="${titleText}">
      <img data-src="/api/prev?rel=${enc(g.preview.rel)}" alt="" decoding="async" loading="lazy">
      ${favMark}
      <div class="tag">${tags}</div></div>`;
  }).join('');

  // 懒加载：只拉“当前视野附近”的，按距视口中心远近排序
  // —— 跳到未尾时，旧位置的在飞请求会被取消，新的立刻占用并发位
  gridWant = new Set();
  gridActive = new Set();
  gridIO = new IntersectionObserver((ents) => {
    for (const e of ents) {
      const card = e.target;
      if (e.isIntersecting) {
        gridWant.add(card);
      } else {
        gridWant.delete(card);
        const img = card.querySelector('img');
        // 已经滚出视野但还在下载 → 直接取消，把并发位让给看得见的
        if (gridActive.has(card) && img && !img.complete && img.getAttribute('src')) {
          gridActive.delete(card);
          img.removeAttribute('src');
          card.classList.add('loading');
        }
      }
    }
    pumpGrid();
  }, { root: null, rootMargin: '150px' });
  document.querySelectorAll('#grid .card').forEach((c) => gridIO.observe(c));
  pumpGrid();

  window._shownGroups = shown;
}

/** 按“离视口中心最近优先”派发缩略图请求 */
function pumpGrid() {
  if (!gridIO) return;                       // 网格已关闭/暂停
  const vh = window.innerHeight || 800;
  const queued = [];
  for (const card of gridWant) {
    const img = card.querySelector('img');
    if (!img || !img.dataset.src || img.getAttribute('src')) continue;
    const r = card.getBoundingClientRect();
    queued.push({ card, img, d: Math.abs(r.top + r.height / 2 - vh / 2) });
  }
  if (!queued.length) return;
  queued.sort((a, b) => a.d - b.d);
  for (const { card, img } of queued) {
    if (gridActive.size >= GRID_CONCURRENCY) break;
    if (!gridIO) break;
    gridActive.add(card);
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      gridActive.delete(card);
      card.classList.remove('loading');
      pumpGrid();
    };
    // 兜底：万一既没 load 也没 error（请求被浏览器丢弃），也不会永久占着并发名额
    timer = setTimeout(() => {
      if (!img.complete) { try { img.removeAttribute('src'); } catch {} }
      done();
    }, 20000);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = img.dataset.src;
  }
}

/** 一张照片的唯一标识：文件名去掉扩展名（不含目录） */
function groupBase(g) {
  return g.main.rel.replace(/\.[^.]+$/, '').split('/').pop();
}
function findGroupIndex(id) {
  const groups = window._shownGroups || [];
  const exact = groups.findIndex((g) => g.base === id);
  if (exact >= 0) return exact;
  return groups.findIndex((g) => groupBase(g) === id);
}

/** 点击卡片加缩略图（缩略图关闭模式） */
function loadCardThumb(card, g) {
  card.classList.add('loading');
  const img = document.createElement('img');
  img.decoding = 'async';
  img.alt = g.main.name;
  img.onload = () => card.classList.remove('loading');
  img.onerror = () => { card.classList.remove('loading'); toast('这张图无法生成预览'); };
  img.src = '/api/prev?rel=' + enc(g.preview.rel);
  card.querySelectorAll('.e,.n,.s').forEach((n) => n.remove());
  card.prepend(img);
  card.dataset.loaded = '1';
  card.title = g.main.name + ' · ' + fmtSize(g.size) + '（再点一次看大图）';
}

$('#filterSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  filter = b.dataset.f;
  [...$('#filterSeg').children].forEach((x) => x.classList.toggle('active', x === b));
  renderGrid();
});

// ---------------------------------------------------------------- 自定义相册名称
function syncDetailAliasInput() {
  const inp = $('#dAlias');
  if (!inp || !currentFolder || currentFolder.isFavorites) return;
  if (document.activeElement === inp) return;
  const val = currentFolder.alias || '';
  inp.value = val;
  inp.classList.toggle('has-val', !!val);
}

async function saveCurrentFolderAlias() {
  const inp = $('#dAlias');
  if (!inp || !currentFolder || currentFolder.isFavorites) return;
  const rel = currentFolder.rel;
  const prev = currentFolder.alias || '';
  const next = normalizeAlbumAlias(inp.value);
  inp.value = next;
  inp.classList.toggle('has-val', !!next);
  if (next === prev) return;

  const seq = ++aliasIntentSeq;
  aliasPendingIntent.set(rel, { alias: next, seq });
  currentFolder.alias = next;
  const sf = STATE.folders.find((x) => x.rel === rel);
  if (sf) sf.alias = next;
  render();

  try {
    const r = await fetch('/api/folder/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, alias: next }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '保存失败');
    const saved = typeof d.alias === 'string' ? d.alias : next;
    const curIntent = aliasPendingIntent.get(rel);
    if (curIntent && curIntent.seq === seq) {
      aliasPendingIntent.delete(rel);
      const sf2 = STATE.folders.find((x) => x.rel === rel);
      if (sf2) sf2.alias = saved;
      if (currentFolder && currentFolder.rel === rel) {
        currentFolder.alias = saved;
        syncDetailAliasInput();
      }
      render();
      toast(saved ? '已保存相册名称' : '已清除相册名称');
    }
  } catch (e) {
    const curIntent = aliasPendingIntent.get(rel);
    if (curIntent && curIntent.seq === seq) {
      aliasPendingIntent.delete(rel);
      const sf2 = STATE.folders.find((x) => x.rel === rel);
      if (sf2) sf2.alias = prev;
      if (currentFolder && currentFolder.rel === rel) {
        currentFolder.alias = prev;
        syncDetailAliasInput();
      }
      render();
      toast('相册名称保存失败：' + (e.message || e));
    }
  }
}

const dAliasInput = $('#dAlias');
if (dAliasInput) {
  dAliasInput.addEventListener('input', () => {
    dAliasInput.classList.toggle('has-val', !!dAliasInput.value.trim());
  });
  dAliasInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      dAliasInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const orig = (currentFolder && !currentFolder.isFavorites) ? (currentFolder.alias || '') : '';
      dAliasInput.value = orig;
      dAliasInput.classList.toggle('has-val', !!orig);
      dAliasInput.blur();
    }
  });
  dAliasInput.addEventListener('blur', () => {
    saveCurrentFolderAlias();
  });
}

$('#btnBack').addEventListener('click', () => closeDetail());
$('#btnOpenFolder').addEventListener('click', () => {
  if (currentFolder) fetch('/api/reveal?rel=' + enc(currentFolder.rel)).then(() => toast(`已在${fileManagerName()}中打开`));
});

/** 关闭详情页；updateHistory=true 时会让浏览器地址栏也跟着回退 */
/** 取消网格里还没下载完的缩略图（浏览器会真的断开请求，服务端跟着 abort ffmpeg） */
function abortGridDownloads() {
  document.querySelectorAll('#grid .card img').forEach((img) => {
    if (!img.complete) {
      const s = img.getAttribute('src');
      if (s) { img.dataset.src = s; img.removeAttribute('src'); }
    }
  });
  gridActive.clear();
  gridWant.clear();
}

function closeDetail(updateHistory = true) {
  const aliasInp = $('#dAlias');
  if (aliasInp && document.activeElement === aliasInp) {
    saveCurrentFolderAlias();
    aliasInp.blur();
  }
  $('#detail').classList.remove('show');
  currentFolder = null;
  favDirtyInDetail = false;
  if (gridIO) { gridIO.disconnect(); gridIO = null; }
  abortGridDownloads();
  // 清空网格：释放已解码的图片占的内存（否则藏在 waite 里的几百张会一直佔着）
  $('#grid').innerHTML = '';
  currentFiles = [];
  window._shownGroups = [];
  resumeThumbWork();
  if (!updateHistory) return;
  if (history.state && history.state.folder) {
    history.back();           // 回到我们 push 的那一条（会触发 popstate）
  } else {
    // 直接带 hash 打开的：只清掉 hash，不产生后退
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/** 根据地址栏状态（文件夹 / 某张照片）还原界面，后退前进都走这里 */
function applyNav(nav) {
  const lbOpen = $('#lb').classList.contains('show');
  if (!nav.folder) {
    if (lbOpen) closeLightbox(false);
    closeDetail(false);
    return;
  }
  if (!currentFolder || currentFolder.rel !== nav.folder) {
    openFolder(nav.folder, { push: false, photo: nav.photo });
    return;
  }
  if (nav.photo) {
    const idx = findGroupIndex(nav.photo);
    if (idx >= 0) openLightbox(idx, { mode: 'none' });
    else if (lbOpen) closeLightbox(false);
  } else if (lbOpen) {
    closeLightbox(false);      // 从大图退回网格
  }
}

// 浏览器前进/后退
window.addEventListener('popstate', () => applyNav(parseNav()));

