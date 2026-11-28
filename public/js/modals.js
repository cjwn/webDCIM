/**
 * 弹窗与全局交互：目录切换弹窗、乐观删除队列与废纸篓弹窗、全局快捷键与启动引导
 */
'use strict';

// ---------------------------------------------------------------- 目录切换弹窗
function showRootErr(msg) {
  const el = $('#rootErr');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function renderRecentRoots() {
  const list = STATE.recent || [];
  const wrap = $('#rootRecentWrap');
  const box = $('#rootRecent');
  if (!list.length) { wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = '';
  box.innerHTML = list.map((p) => {
    const isCur = STATE.root && p === STATE.root;
    const delBtn = STATE.isLocal ? `<button class="rdel" data-del="${escHtml(p)}" title="从历史记录移除">✕</button>` : '';
    return `<div class="recent-item ${isCur ? 'cur' : ''}" data-path="${escHtml(p)}">
      <span class="rp" title="${escHtml(p)}">${escHtml(p)}</span>
      ${isCur ? '<span class="rtag">当前</span>' : ''}
      ${delBtn}
    </div>`;
  }).join('');
}

function openRootModal() {
  const local = STATE.isLocal !== false;
  $('#rootLocalControls').style.display = local ? '' : 'none';
  $('#rootLanNote').style.display = local ? 'none' : '';
  const input = $('#rootInput');
  input.value = STATE.root || '';
  input.placeholder = STATE.platform === 'win32'
    ? '或直接粘贴路径，如 E:\\OUTPUT'
    : '或直接粘贴路径，如 /Volumes/PhotoSSD/OUTPUT';
  showRootErr('');
  renderRecentRoots();
  $('#rootModal').classList.add('show');
  if (local) setTimeout(() => { input.focus(); input.select(); }, 30);
}

function closeRootModal() {
  $('#rootModal').classList.remove('show');
}

function afterRootSwitched(newRoot) {
  closeRootModal();
  lbExifCache.clear();
  lbSharpCache.clear();
  favoriteSet.clear();
  favPendingIntent.clear();
  aliasPendingIntent.clear();
  favoriteAddedAt = {};
  favDirtyInDetail = false;
  if ($('#lb').classList.contains('show')) closeLightbox(false);
  if ($('#detail').classList.contains('show')) closeDetail(false);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  toast('已切换到：' + newRoot);
  pull();
}

async function switchRootTo(targetPath) {
  const p = (targetPath || '').trim();
  if (!p) { showRootErr('请输入目录路径'); return; }
  showRootErr('');
  const btn = $('#btnRootApply');
  btn.disabled = true;
  try {
    const r = await fetch('/api/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const d = await r.json();
    if (!d.ok) { showRootErr(d.error || '切换失败'); return; }
    afterRootSwitched(d.root);
  } catch (e) {
    showRootErr('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

$('#rootPath').addEventListener('click', openRootModal);
$('#btnRootClose').addEventListener('click', closeRootModal);
$('#rootModal').addEventListener('click', (e) => { if (e.target.id === 'rootModal') closeRootModal(); });
$('#btnRootApply').addEventListener('click', () => switchRootTo($('#rootInput').value));
$('#rootInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); switchRootTo($('#rootInput').value); } });

$('#btnRootPick').addEventListener('click', async () => {
  const btn = $('#btnRootPick');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '请在系统窗口中选择文件夹…';
  showRootErr('');
  try {
    const r = await fetch('/api/root/pick', { method: 'POST' });
    const d = await r.json();
    if (d.cancelled) return;
    if (!d.ok) { showRootErr(d.error || '选择失败'); return; }
    afterRootSwitched(d.root);
  } catch (e) {
    showRootErr('调用系统选择器失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

$('#rootRecent').addEventListener('click', async (e) => {
  const del = e.target.closest('.rdel');
  if (del) {
    e.stopPropagation();
    const p = del.dataset.del;
    try {
      const r = await fetch('/api/root/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const d = await r.json();
      if (d.ok) { STATE.recent = d.recent || []; renderRecentRoots(); }
    } catch {}
    return;
  }
  const item = e.target.closest('.recent-item');
  if (!item) return;
  switchRootTo(item.dataset.path);
});

// ---------------------------------------------------------------- 删除照片（乐观更新 + 后台串行移入回收站）
const trashName = () => (STATE.platform === 'win32' ? '回收站' : '废纸篓');
const pendingDeleteRels = new Set();
const deleteQueue = [];
let deleteWorkerRunning = false;

function closeDelModal() {
  const m = $('#delModal');
  m.classList.remove('show');
  if (m.parentElement !== document.body) document.body.appendChild(m);
}

function showDelErr(msg) {
  const el = $('#delErr');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function rollbackDeletedRows(rows, folderRel, restoreFavBases) {
  if (restoreFavBases && restoreFavBases.length) {
    for (const b of restoreFavBases) favoriteSet.add(b);
  }
  if (!rows.length || currentFolder !== folderRel) return;
  const existing = new Set(currentFiles.map(([r]) => r));
  const toAdd = rows.filter(([r]) => !existing.has(r));
  if (!toAdd.length) return;
  const lbOpen = $('#lb').classList.contains('show');
  const activeGroup = lbOpen ? (window._shownGroups || [])[lbIndex] : null;
  const activeBase = activeGroup ? activeGroup.base : null;
  currentFiles = [...currentFiles, ...toAdd].sort((a, b) => a[0].localeCompare(b[0]));
  currentGroups = groupFiles(currentFiles);
  if (currentFolder && currentFolder.isFavorites) updateFavoritesDetailMeta();
  renderGrid();
  if (lbOpen && activeBase) {
    const nextIdx = (window._shownGroups || []).findIndex((x) => x.base === activeBase);
    if (nextIdx >= 0) lbIndex = nextIdx;
    syncLbFavUI();
  }
}

async function drainDeleteQueue() {
  if (deleteWorkerRunning) return;
  deleteWorkerRunning = true;
  let anyChanged = false;
  try {
    while (deleteQueue.length) {
      const job = deleteQueue.shift();
      let ok = false, errMsg = '', deletedList = [];
      try {
        const r = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rels: job.rels }),
        });
        const raw = await r.text();
        let d = null;
        try { d = JSON.parse(raw); } catch {
          errMsg = r.status === 404
            ? '后端服务还是旧版本（缺少 /api/delete 接口），请重启 server.js'
            : `服务端返回异常 (HTTP ${r.status})`;
        }
        if (d) {
          ok = !!d.ok;
          deletedList = Array.isArray(d.deleted) ? d.deleted : (ok ? job.rels : []);
          if (!ok) errMsg = d.error || '删除失败';
        }
      } catch (e) {
        errMsg = '请求失败：' + e.message;
      }

      const doneSet = new Set(deletedList);
      if (doneSet.size) anyChanged = true;
      for (const rel of job.rels) pendingDeleteRels.delete(rel);

      if (!ok) {
        const failedRows = job.removedRows.filter(([rel]) => !doneSet.has(rel));
        const restoreFavs = (job.removedFavBases || []).filter((b) => failedRows.some(([rel]) => baseOfRel(rel) === b));
        rollbackDeletedRows(failedRows, job.folderRel, restoreFavs);
        toast(`删除失败（已恢复）：${errMsg}`);
      }
    }
  } finally {
    deleteWorkerRunning = false;
    if (anyChanged) pull();
  }
}

window.addEventListener('beforeunload', (e) => {
  if (deleteWorkerRunning || deleteQueue.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function execDeleteRels(rels, groupKeyBefore) {
  const uniq = [...new Set((rels || []).filter(Boolean))];
  if (!uniq.length) return;
  const delSet = new Set(uniq);
  const removedRows = currentFiles.filter(([rel]) => delSet.has(rel));
  const folderRel = currentFolder;

  for (const rel of delSet) {
    pendingDeleteRels.add(rel);
    lbExifCache.delete(rel);
  }

  // 0ms 乐观更新：立刻关窗、从列表移除并切到下一张，往回翻也不会再出现已删照片
  closeDelModal();
  currentFiles = currentFiles.filter(([rel]) => !delSet.has(rel));
  // 若被删照片整组已无残余文件，前端乐观同步移除收藏标记（失败时回滚）
  const aliveBases = new Set(currentFiles.map(([r]) => baseOfRel(r)));
  const removedFavBases = [];
  for (const rel of delSet) {
    const b = baseOfRel(rel);
    if (favoriteSet.has(b) && !aliveBases.has(b)) {
      favoriteSet.delete(b);
      removedFavBases.push(b);
    }
  }
  currentGroups = groupFiles(currentFiles);
  if (currentFolder && currentFolder.isFavorites) updateFavoritesDetailMeta();
  const prevIdx = lbIndex;
  renderGrid();

  const groups = window._shownGroups || [];
  if (!groups.length) {
    closeLightbox();
  } else {
    const sameIdx = groups.findIndex((x) => x.base === groupKeyBefore);
    const nextIdx = sameIdx >= 0
      ? sameIdx
      : (lbLastDir < 0 ? Math.max(0, prevIdx - 1) : Math.min(prevIdx, groups.length - 1));
    openLightbox(nextIdx, { mode: 'replace' });
  }
  toast(`已移入${trashName()}（${delSet.size} 个文件）`);

  // 交给后台串行队列真正移入系统回收站/废纸篓
  deleteQueue.push({ rels: uniq, removedRows, folderRel, removedFavBases });
  drainDeleteQueue();
}

function openDelModal() {
  if (STATE.isLocal === false) return;
  const groups = window._shownGroups || [];
  const g = groups[lbIndex];
  if (!g || !g.items.length) return;
  const tn = trashName();
  $('#delTitle').textContent = `🗑 移入${tn}`;
  $('#delNote').textContent = `文件会移入系统${tn}，不会永久删除，可在${tn}中恢复。`;
  showDelErr('');
  $('#delFiles').innerHTML = g.items.map((it) =>
    `<div class="del-file"><span class="df-name">${escHtml(it.name)}</span><span class="df-size">${fmtSize(it.size)}</span></div>`
  ).join('');
  const act = $('#delActions');
  act.innerHTML = '';
  const baseBefore = g.base;
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeDelModal);
  act.appendChild(cancelBtn);

  if (g.items.length > 1) {
    for (const it of g.items) {
      const b = document.createElement('button');
      b.textContent = `仅删 ${it.ext.replace('.', '')}`;
      b.addEventListener('click', () => execDeleteRels([it.rel], baseBefore));
      act.appendChild(b);
    }
    const allBtn = document.createElement('button');
    allBtn.id = 'btnDelConfirmAll';
    allBtn.className = 'btn-danger';
    allBtn.textContent = `🗑 全部移入${tn} (${fmtSize(g.size)}) [D]`;
    allBtn.addEventListener('click', () => execDeleteRels(g.items.map((x) => x.rel), baseBefore));
    act.appendChild(allBtn);
  } else {
    const oneBtn = document.createElement('button');
    oneBtn.id = 'btnDelConfirmAll';
    oneBtn.className = 'btn-danger';
    oneBtn.textContent = `🗑 移入${tn} [D]`;
    oneBtn.addEventListener('click', () => execDeleteRels([g.items[0].rel], baseBefore));
    act.appendChild(oneBtn);
  }
  // 全屏时仅 fullscreenElement 内部可见，把确认弹窗临时挂进去，删完自动留在全屏看下一张
  const modal = $('#delModal');
  const fsEl = document.fullscreenElement;
  if (fsEl && modal.parentElement !== fsEl) fsEl.appendChild(modal);
  else if (!fsEl && modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.classList.add('show');
}

$('#lbDelete').addEventListener('click', openDelModal);
$('#btnDelClose').addEventListener('click', closeDelModal);
$('#delModal').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.id === 'delModal') closeDelModal();
});
$('#delModal').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#delModal').addEventListener('dblclick', (e) => e.stopPropagation());
document.addEventListener('fullscreenchange', () => {
  const modal = $('#delModal');
  if (!document.fullscreenElement && modal && modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }
  const t = $('#toast');
  if (!document.fullscreenElement && t && t.parentElement !== document.body) {
    document.body.appendChild(t);
  }
});

document.addEventListener('keydown', (e) => {
  if ($('#delModal').classList.contains('show')) {
    if (e.key === 'Escape') { e.preventDefault(); closeDelModal(); return; }
    if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      const btn = $('#btnDelConfirmAll');
      if (btn && !btn.disabled) btn.click();
    }
    return;
  }
  if ($('#rootModal').classList.contains('show')) {
    if (e.key === 'Escape') { e.preventDefault(); closeRootModal(); }
    return;
  }
  if ($('#lb').classList.contains('show')) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); return; }
    if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      toggleCurrentFavorite();
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); lbMove(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); lbMove(1); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      if (STATE.isLocal !== false) openDelModal();
      return;
    }
    if ((e.code === 'Space' || e.key === ' ') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      const g = (window._shownGroups || [])[lbIndex];
      if (g && !isVideoGroup(g) && g.items.find((x) => x.kind === 'raw') && lastRawPreset) {
        e.preventDefault();
        toggleLastRawPreset();
      }
      return;
    }
    if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      const g = (window._shownGroups || [])[lbIndex];
      if (g && !isVideoGroup(g) && g.items.find((x) => x.kind === 'raw')) {
        e.preventDefault();
        toggleRawClip();
      }
      return;
    }
    if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      const g = (window._shownGroups || [])[lbIndex];
      if (g && !isVideoGroup(g)) {
        e.preventDefault();
        toggleFocusPeaking();
      }
      return;
    }
    return;
  }
  if (e.key === 'Escape' && $('#detail').classList.contains('show')) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    closeDetail();
  }
});

pull();
setThumbMode(thumbMode);
setThumbSize(thumbSize);
// 页面一打开就清掉可能残留的暂停状态（上次放视频时关标签页留下的）
fetch('/api/preview/resume', { method: 'POST' }).catch(() => {});
