/**
 * RAW 实时显影预览：曝光 / 暗部 / 高光调节与两级物理溢出检查（含可调噪底阈值）
 */
'use strict';

// RAW 曝光（-4 ~ +4 EV，步进 0.5）、暗部提亮（0~200%）、高光压暗（0~200%）、两级线性溢出检查（G）
let rawEv = 0, rawSh = 0, rawHl = 0, rawClip = 0, rawDevTimer = null;
let rawNoisePct = (() => {
  try {
    const v = localStorage.getItem('rawNoisePct');
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 5) return Math.round(n * 1000) / 1000;
    }
  } catch {}
  return 0.1;
})();
let lastRawPreset = (() => {
  try {
    const p = JSON.parse(localStorage.getItem('rawPreset') || 'null');
    if (p && (Number(p.ev) || Number(p.sh) || Number(p.hl))) {
      return { ev: Number(p.ev) || 0, sh: Number(p.sh) || 0, hl: Number(p.hl) || 0 };
    }
  } catch {}
  return null;
})();

function formatRawPreset(ev, sh, hl) {
  const parts = [];
  if (ev) parts.push(`${ev > 0 ? '+' : ''}${ev} EV`);
  if (sh) parts.push(`暗部 ${Math.round(sh * 100)}%`);
  if (hl) parts.push(`高光 -${Math.round(hl * 100)}%`);
  return parts.join(' · ');
}

function syncRawDevUI() {
  const evTxt = (rawEv > 0 ? '+' : '') + rawEv + ' EV';
  const evEl = $('#rawEvVal');
  if (evEl) evEl.textContent = rawEv >= 0 ? evTxt : '0 EV';
  const evDarkEl = $('#rawEvDarkVal');
  if (evDarkEl) evDarkEl.textContent = rawEv <= 0 ? evTxt : '0 EV';
  const shEl = $('#rawShVal');
  if (shEl) shEl.textContent = Math.round(rawSh * 100) + '%';
  const hlEl = $('#rawHlVal');
  if (hlEl) hlEl.textContent = rawHl ? `-${Math.round(rawHl * 100)}%` : '0%';
  [...$('#rawDevSeg').children].forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.ev) - rawEv) < 1e-4));
  [...$('#rawDevDarkSeg').children].forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.ev) - rawEv) < 1e-4));
  [...$('#rawShadowSeg').children].forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.sh) - rawSh) < 1e-4));
  [...$('#rawHighlightSeg').children].forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.hl) - rawHl) < 1e-4));
  const clipBtn = $('#btnRawClip');
  if (clipBtn) clipBtn.classList.toggle('active', !!rawClip);
  const noiseBox = $('#rawNoiseBox');
  const noiseInp = $('#inpRawNoise');
  if (noiseBox) noiseBox.classList.toggle('on', !!rawClip && rawNoisePct > 0);
  if (noiseInp && document.activeElement !== noiseInp) noiseInp.value = String(rawNoisePct);
  const applyBtn = $('#btnApplyLastRaw');
  if (applyBtn) {
    const same = lastRawPreset &&
      Math.abs(lastRawPreset.ev - rawEv) < 1e-4 &&
      Math.abs(lastRawPreset.sh - rawSh) < 1e-4 &&
      Math.abs((lastRawPreset.hl || 0) - rawHl) < 1e-4;
    if (lastRawPreset && !same) {
      applyBtn.textContent = `⚡ 套用上次 (${formatRawPreset(lastRawPreset.ev, lastRawPreset.sh, lastRawPreset.hl || 0)}) [空格]`;
      applyBtn.style.display = '';
    } else {
      applyBtn.style.display = 'none';
    }
  }
}

function resetRawDevState() {
  clearTimeout(rawDevTimer); rawDevTimer = null;
  rawEv = 0; rawSh = 0; rawHl = 0; rawClip = 0;
  syncRawDevUI();
}

function applyRawDevPreview() {
  clearTimeout(rawDevTimer); rawDevTimer = null;
  const g = (window._shownGroups || [])[lbIndex];
  const raw = g && g.items.find((x) => x.kind === 'raw');
  const canvasEl = $('#lbCanvas');
  if (!g || !raw || !canvasEl) return;

  const ev = rawEv;
  const sh = rawSh;
  const hl = rawHl;
  const clip = rawClip ? 1 : 0;
  if (ev || sh || hl) {
    lastRawPreset = { ev, sh, hl };
    try { localStorage.setItem('rawPreset', JSON.stringify(lastRawPreset)); } catch {}
  }
  syncRawDevUI();
  const presetTxt = formatRawPreset(ev, sh, hl);
  const labelParts = [];
  if (presetTxt) labelParts.push(presetTxt);
  if (clip) labelParts.push(rawNoisePct > 0 ? `溢出(红高光/蓝死黑/浅蓝≤${rawNoisePct}%)` : '溢出(红高光/蓝死黑)');
  const label = labelParts.length ? `RAW ${labelParts.join(' · ')}` : '原预览';

  const nt = $('#qualityNote');
  const maxPx = bigQuality === 'full' ? 0 : 2048;
  const targetSrc = (!ev && !sh && !hl && !clip)
    ? bigSrcFor(g)
    : `/api/rawdev?rel=${enc(raw.rel)}&ev=${enc(ev)}&sh=${enc(sh)}&hl=${enc(hl)}&clip=${clip}&np=${enc(rawNoisePct)}&max=${maxPx}&v=16`;
  const prevImg = (lbView && lbView.img && canvasEl.contains(lbView.img)) ? lbView.img : null;
  lbDropPending();
  if (prevImg) prevImg.classList.add('lb-stale');
  lbLoading = true;
  lbSpinner(true);
  if (nt) nt.textContent = (!ev && !sh && !hl && !clip) ? '恢复原预览…' : `${label} 解码中…`;

  const myIdx = lbIndex;
  const img = document.createElement('img');
  img.dataset.pending = '1';
  img.style.visibility = 'hidden';
  canvasEl.appendChild(img);

  const finish = async () => {
    if (!img.naturalWidth || !canvasEl.contains(img) || lbIndex !== myIdx) return;
    try { if (img.decode) await img.decode(); } catch {}
    if (!canvasEl.contains(img) || lbIndex !== myIdx) return;
    img.removeAttribute('data-pending');
    lbReset(img);
    lbSpinner(false);
    lbLoading = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (canvasEl.contains(img)) lbKeepOnly(img);
    }));
    if (nt) nt.textContent = `${label} · ${img.naturalWidth}×${img.naturalHeight}`;
    scheduleLbSharpness(img, g, !!clip);
  };
  img.addEventListener('load', finish, { once: true });
  img.addEventListener('error', () => {
    if (!canvasEl.contains(img)) return;
    img.remove();
    if (prevImg) prevImg.classList.remove('lb-stale');
    lbSpinner(false);
    lbLoading = false;
    if (nt) nt.textContent = 'RAW 显影预览失败';
    toast('RAW 显影预览失败');
  }, { once: true });
  img.src = targetSrc;
  if (img.complete && img.naturalWidth) finish();
}

function scheduleRawDev() {
  syncRawDevUI();
  clearTimeout(rawDevTimer);
  rawDevTimer = setTimeout(applyRawDevPreview, 180);
}

$('#rawDevSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  rawEv = Number(b.dataset.ev) || 0;
  syncRawDevUI();
  applyRawDevPreview();
});
$('#rawDevDarkSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  rawEv = Number(b.dataset.ev) || 0;
  syncRawDevUI();
  applyRawDevPreview();
});
$('#rawShadowSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  rawSh = Number(b.dataset.sh) || 0;
  syncRawDevUI();
  applyRawDevPreview();
});
$('#rawHighlightSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  rawHl = Number(b.dataset.hl) || 0;
  syncRawDevUI();
  applyRawDevPreview();
});
const stepEv = (delta) => {
  rawEv = Math.max(-4, Math.min(4, Math.round((rawEv + delta) * 2) / 2));
  scheduleRawDev();
};
$('#btnEvMinus').addEventListener('click', () => stepEv(-0.5));
$('#btnEvPlus').addEventListener('click', () => stepEv(0.5));
$('#btnEvDarkMinus').addEventListener('click', () => stepEv(-0.5));
$('#btnEvDarkPlus').addEventListener('click', () => stepEv(0.5));
$('#btnShMinus').addEventListener('click', () => {
  rawSh = Math.max(0, Math.round((rawSh - 0.1) * 20) / 20);
  scheduleRawDev();
});
$('#btnShPlus').addEventListener('click', () => {
  rawSh = Math.min(2, Math.round((rawSh + 0.1) * 20) / 20);
  scheduleRawDev();
});
$('#btnHlMinus').addEventListener('click', () => {
  rawHl = Math.max(0, Math.round((rawHl - 0.1) * 20) / 20);
  scheduleRawDev();
});
$('#btnHlPlus').addEventListener('click', () => {
  rawHl = Math.min(2, Math.round((rawHl + 0.1) * 20) / 20);
  scheduleRawDev();
});
function toggleLastRawPreset() {
  if (!lastRawPreset) return;
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || isVideoGroup(g) || !g.items.find((x) => x.kind === 'raw')) return;
  const pHl = lastRawPreset.hl || 0;
  const same = Math.abs(lastRawPreset.ev - rawEv) < 1e-4 &&
    Math.abs(lastRawPreset.sh - rawSh) < 1e-4 &&
    Math.abs(pHl - rawHl) < 1e-4;
  if (same) {
    rawEv = 0;
    rawSh = 0;
    rawHl = 0;
  } else {
    rawEv = lastRawPreset.ev;
    rawSh = lastRawPreset.sh;
    rawHl = pHl;
  }
  syncRawDevUI();
  applyRawDevPreview();
}

function toggleRawClip() {
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || isVideoGroup(g) || !g.items.find((x) => x.kind === 'raw')) return;
  rawClip = rawClip ? 0 : 1;
  syncRawDevUI();
  applyRawDevPreview();
}
function commitRawNoiseInput(autoEnable = true) {
  const inp = $('#inpRawNoise');
  if (!inp) return;
  const parsed = Number(String(inp.value).trim());
  const next = Number.isFinite(parsed)
    ? Math.max(0, Math.min(5, Math.round(parsed * 1000) / 1000))
    : rawNoisePct;
  const changed = Math.abs(next - rawNoisePct) > 1e-6;
  rawNoisePct = next;
  inp.value = String(rawNoisePct);
  try { localStorage.setItem('rawNoisePct', String(rawNoisePct)); } catch {}
  const g = (window._shownGroups || [])[lbIndex];
  if (!g || isVideoGroup(g) || !g.items.find((x) => x.kind === 'raw')) {
    syncRawDevUI();
    return;
  }
  if (changed || (autoEnable && !rawClip)) {
    if (autoEnable && !rawClip) rawClip = 1;
    syncRawDevUI();
    applyRawDevPreview();
  } else {
    syncRawDevUI();
  }
}
$('#btnRawClip').addEventListener('click', toggleRawClip);
$('#inpRawNoise').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRawNoiseInput(true);
    e.target.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.target.value = String(rawNoisePct);
    e.target.blur();
  }
});
$('#inpRawNoise').addEventListener('focus', (e) => { e.target.select(); });
$('#inpRawNoise').addEventListener('blur', () => commitRawNoiseInput(false));
$('#inpRawNoise').addEventListener('change', () => commitRawNoiseInput(true));
$('#btnApplyLastRaw').addEventListener('click', toggleLastRawPreset);

