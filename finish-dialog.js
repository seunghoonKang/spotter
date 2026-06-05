let videoUrl = null;
let history = [];
let environment = null;
let selected = 'report';

// Apply i18n to all data-i18n elements on load.
applyI18n();

const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const cancelBtn = document.getElementById('cancel');
const optionsEl = document.getElementById('options');

window.addEventListener('message', (ev) => {
  if (ev.data?.type !== 'SPOTTER_FINISH_DATA') return;
  videoUrl = ev.data.videoUrl;
  history = ev.data.history || [];
  environment = ev.data.environment || null;

  const shots = history.filter((h) => h.screenshot).length;
  // English uses pluralization, Korean doesn't — pass the 's' (or empty) so
  // English message can include it via $PLURAL$ while Korean ignores it.
  const eventsText = t('finishMetaEvents', [String(history.length), history.length === 1 ? '' : 's']);
  const shotsText = t('finishMetaShots', [String(shots), shots === 1 ? '' : 's']);
  const videoText = videoUrl ? t('finishMetaVideoReady') : t('finishMetaNoVideo');
  document.getElementById('meta').textContent = `${eventsText} · ${shotsText} · ${videoText}`;

  // If video isn't available, disable video-bearing options and fall back to history-only.
  if (!videoUrl) {
    ['report', 'both', 'video'].forEach((v) => {
      const opt = optionsEl.querySelector(`[data-value="${v}"]`);
      if (opt) {
        opt.style.opacity = '0.4';
        opt.style.pointerEvents = 'none';
      }
    });
    selectOption('history');
  }
});

function selectOption(value) {
  selected = value;
  optionsEl.querySelectorAll('.option').forEach((opt) => {
    opt.classList.toggle('selected', opt.dataset.value === value);
  });
}

optionsEl.addEventListener('click', (e) => {
  const opt = e.target.closest('.option');
  if (!opt) return;
  selectOption(opt.dataset.value);
});

function close() {
  window.parent.postMessage({ type: 'SPOTTER_FINISH_CLOSE' }, '*');
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Human-facing date formatter for the report header. Uses the user's locale
// (Chrome UI language) and timezone — so a Korean user sees "2026년 5월 28일
// 오후 2:55" while an English user sees "May 28, 2026, 2:55 PM".
function formatHumanDate(date) {
  const locale = chrome.i18n.getUILanguage() || 'en';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'long',
      timeStyle: 'short'
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

// "UTC+9" / "UTC-5:30" form. Reflects the current system, not the recording.
// Use only when the env snapshot didn't carry a timezone of its own.
function describeOffset() {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

// "Asia/Seoul (UTC+9)" form. Fallback when env snapshot has no timezone.
function describeTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return tz ? `${tz} (${describeOffset()})` : describeOffset();
  } catch {
    return '';
  }
}

function setBusy(busy, label) {
  saveBtn.disabled = busy;
  cancelBtn.disabled = busy;
  optionsEl.style.pointerEvents = busy ? 'none' : '';
  optionsEl.style.opacity = busy ? '0.5' : '';
  if (busy) {
    saveBtn.innerHTML = `<span class="spinner"></span><span>${label || t('finishStatusSaving')}</span>`;
  } else {
    saveBtn.textContent = t('finishBtnSave');
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// Fetch a blob: URL and return base64 data URL via FileReader.
async function blobUrlToDataUrl(blobUrl) {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${cs}`;
}

// Inline SVG icon next to certain timeline rows. Currently only used for Spot
// (annotation) rows — a mini reticle that matches the extension icon.
function kindIcon(kind) {
  if (kind === 'annotation') {
    return `<svg class="kind-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <line x1="8" y1="1.5" x2="8" y2="3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="8" y1="13" x2="8" y2="14.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="1.5" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="13" y1="8" x2="14.5" y2="8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="8" cy="8" r="2" fill="#ff3b30"/>
    </svg>`;
  }
  return '';
}

function describeEvent(ev) {
  const countSuffix = ev.count && ev.count > 1 ? ` × ${ev.count}` : '';
  if (ev.kind === 'navigation' || ev.kind === 'spa-navigation') {
    return {
      label: ev.kind === 'spa-navigation' ? t('reportEventSpaNavigation') : t('reportEventNavigation'),
      detail: ev.url || ''
    };
  }
  if (ev.kind === 'click') {
    const el = ev.element || {};
    const tag = el.tag || 'element';
    const role = el.role ? `[role=${el.role}]` : '';
    const name = el.text || el.ariaLabel || el.href || el.selector || '';
    return {
      label: t('reportEventClick', [tag, role]),
      detail: name
    };
  }
  if (ev.kind === 'annotation') {
    return {
      label: t('reportEventSpot'),
      detail: ev.text || ''
    };
  }
  if (ev.kind === 'console-error') {
    return {
      label: t('reportEventConsoleError') + countSuffix,
      detail: (ev.message || '') + (ev.source ? `  (${ev.source})` : '')
    };
  }
  if (ev.kind === 'network-error') {
    const statusLabel = ev.status ? String(ev.status) : t('reportEventNetworkFailed');
    return {
      label: `${ev.method || 'GET'} ${statusLabel}` + countSuffix,
      detail: ev.url || ''
    };
  }
  return { label: ev.kind || 'event', detail: '' };
}

// Spotter reticle favicon — same design as the extension icon, inlined as
// a data URL so the report stays a single self-contained file.
// Must be fully URL-encoded; the raw SVG contains double quotes that would
// otherwise break the surrounding href="" attribute when embedded.
const FAVICON_SVG_RAW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="#a3e635" stroke-width="1.5" fill="none"/><g stroke="#a3e635" stroke-width="1.2" stroke-linecap="round"><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/></g><circle cx="8" cy="8" r="2.2" fill="#ff3b30"/></svg>`;
const FAVICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG_RAW)}`;

function renderEnvironmentHtml(env) {
  if (!env) return '';
  const rows = [];
  if (env.url) rows.push([t('reportEnvUrl'), env.url]);
  if (env.viewport) rows.push([t('reportEnvViewport'), `${env.viewport.w} × ${env.viewport.h} @ ${env.dpr}x`]);
  if (env.platform || env.mobile) rows.push([t('reportEnvPlatform'), env.platform + (env.mobile ? ' ' + t('reportEnvPlatformMobile') : '')]);
  if (env.brands) rows.push([t('reportEnvBrowser'), env.brands]);
  if (env.language) rows.push([t('reportEnvLanguage'), env.language]);
  // Prefer the timezone captured during recording; fall back to current system
  // timezone if the snapshot didn't have one (older recordings).
  const tz = env.timezone ? `${env.timezone} (${describeOffset()})` : describeTimezone();
  if (tz) rows.push([t('reportEnvTimezone'), tz]);
  if (env.ua) rows.push([t('reportEnvUA'), env.ua]);
  if (!rows.length) return '';
  return `
    <details class="env">
      <summary>${escapeHtml(t('reportEnvironment'))}</summary>
      <div class="env-body">
        <dl>
          ${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}
        </dl>
      </div>
    </details>
  `;
}

function buildReportHtml(videoDataUrl) {
  const rows = history.map((ev, i) => {
    const { label, detail } = describeEvent(ev);
    const icon = kindIcon(ev.kind);
    const screenshot = ev.screenshot
      ? `<img class="shot" src="${ev.screenshot}" alt="screenshot at ${formatTime(ev.t)}" />`
      : `<div class="shot empty">${escapeHtml(t('reportNoShot'))}</div>`;
    return `
      <li class="event kind-${ev.kind}" data-t="${ev.t}" data-index="${i}">
        <span class="ts">${formatTime(ev.t)}</span>
        <div class="info">
          <div class="label">${icon}<span>${escapeHtml(label)}</span></div>
          <div class="detail">${escapeHtml(detail)}</div>
        </div>
        ${screenshot}
      </li>
    `;
  }).join('');

  const now = new Date();
  const generatedAtIso = now.toISOString();        // for the title (sortable, unambiguous)
  const generatedAtHuman = formatHumanDate(now);   // for the meta line (localized)
  const eventCount = history.length;
  const shotCount = history.filter((h) => h.screenshot).length;
  const errorCount = history.reduce((n, h) => {
    if (h.kind === 'console-error' || h.kind === 'network-error') return n + (h.count || 1);
    return n;
  }, 0);
  const envHtml = renderEnvironmentHtml(environment);
  const videoBlock = videoDataUrl
    ? `<video id="player" controls preload="metadata" src="${videoDataUrl}"></video>`
    : `<div class="no-video">${escapeHtml(t('reportNoVideo'))}</div>`;
  // Report is a frozen artifact — locale at generation time becomes the file's locale.
  const reportLang = (chrome.i18n.getUILanguage() || 'en').split('-')[0];
  const eventsText = t('finishMetaEvents', [String(eventCount), eventCount === 1 ? '' : 's']);
  const shotsText = t('finishMetaShots', [String(shotCount), shotCount === 1 ? '' : 's']);
  const errorsText = errorCount
    ? ` · <span style="color: var(--rec);">${escapeHtml(t('reportMetaErrors', [String(errorCount), errorCount === 1 ? '' : 's']))}</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="${reportLang}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(t('reportTitleWithDate', [generatedAtIso]))}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URL}" />
<style>
  :root {
    --bg: #0d120e;
    --panel: #14191a;
    --fg: #e6f0e0;
    --muted: #8a9080;
    --accent: #a3e635;
    --accent-soft: #bef264;
    --accent-dim: rgba(163, 230, 53, 0.08);
    --border: #1f2818;
    --hover: #161d17;
    --rec: #ff3b30;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    height: 100%;
    overflow: hidden;
  }
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
    display: flex; flex-direction: column;
  }
  header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: baseline; gap: 16px;
    flex-shrink: 0;
  }
  header h1 {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0;
  }
  header .meta {
    color: var(--muted);
    font-size: 11px;
  }
  .layout {
    display: grid;
    grid-template-columns: 1fr 420px;
    flex: 1;
    min-height: 0; /* allows children to shrink so grid overflow is contained */
  }
  .video-pane {
    padding: 24px;
    background: var(--bg);
    display: flex; align-items: center; justify-content: center;
    min-width: 0; min-height: 0;
    overflow: hidden;
  }
  video, .no-video {
    width: 100%;
    max-height: 100%;
    border-radius: 8px;
    background: #000;
  }
  .no-video {
    color: var(--muted);
    padding: 40px;
    text-align: center;
    border: 1px dashed var(--border);
  }
  .timeline {
    border-left: 1px solid var(--border);
    overflow-y: auto;
    padding: 16px;
    min-height: 0;
  }
  .timeline h2 {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 12px 0;
  }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .event {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    transition: border-color 280ms ease, background-color 280ms ease;
    cursor: pointer;
  }
  .event:hover { background: var(--hover); }
  .event.active {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  /* Errors get a red ts marker so they're scannable on the timeline. */
  .event.kind-console-error .ts,
  .event.kind-network-error .ts {
    color: var(--rec);
    border-color: rgba(255, 59, 48, 0.4);
  }
  .event.kind-console-error .label,
  .event.kind-network-error .label {
    color: var(--rec);
  }
  .event.kind-console-error .detail,
  .event.kind-network-error .detail {
    white-space: normal;
    word-break: break-word;
  }
  .ts {
    color: var(--accent);
    font-size: 11px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    min-width: 56px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    user-select: none;
    transition: border-color 280ms ease, background-color 280ms ease;
  }
  .event.active .ts {
    border-color: var(--accent);
  }
  .info { min-width: 0; overflow: hidden; }
  .label {
    color: var(--fg);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .kind-icon {
    width: 14px;
    height: 14px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .detail {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Environment strip at the top of the report. Collapsible. */
  .env {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .env summary {
    list-style: none;
    cursor: pointer;
    padding: 12px 24px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex; align-items: center; gap: 8px;
    user-select: none;
  }
  .env summary::-webkit-details-marker { display: none; }
  .env summary::before {
    content: '▸';
    color: var(--muted);
    font-size: 10px;
    transition: transform 150ms;
  }
  .env[open] summary::before { transform: rotate(90deg); }
  .env-body {
    padding: 4px 24px 16px;
  }
  .env-body dl {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 4px 16px;
    margin: 0;
    font-size: 12px;
  }
  .env-body dt {
    color: var(--muted);
  }
  .env-body dd {
    margin: 0;
    color: var(--fg);
    word-break: break-all;
  }
  .shot {
    width: 64px; height: 40px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--border);
    cursor: zoom-in;
  }
  .shot.empty {
    display: flex; align-items: center; justify-content: center;
    color: var(--muted);
    font-size: 10px;
    background: var(--bg);
  }
  /* Lightbox */
  .lightbox {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.85);
    display: none; align-items: center; justify-content: center;
    z-index: 1000;
    cursor: zoom-out;
  }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 95vw; max-height: 95vh; border-radius: 4px; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(t('reportTitle'))}</h1>
    <div class="meta">${escapeHtml(generatedAtHuman)} · ${escapeHtml(eventsText)} · ${escapeHtml(shotsText)}${errorsText}</div>
  </header>
  ${envHtml}
  <div class="layout">
    <div class="video-pane">${videoBlock}</div>
    <aside class="timeline">
      <h2>${escapeHtml(t('reportTimeline'))}</h2>
      <ul id="events">${rows}</ul>
    </aside>
  </div>
  <div class="lightbox" id="lightbox"><img id="lightbox-img" /></div>
<script>
(function() {
  var player = document.getElementById('player');
  var events = document.getElementById('events');
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');

  var eventEls = Array.prototype.slice.call(events.querySelectorAll('.event'));
  // Ascending list of {t, el}. Already in order, but be defensive.
  var index = eventEls.map(function(el) {
    return { t: parseInt(el.getAttribute('data-t'), 10), el: el };
  }).sort(function(a, b) { return a.t - b.t; });

  function setActive(el) {
    if (!el || el.classList.contains('active')) return;
    eventEls.forEach(function(e) { e.classList.remove('active'); });
    el.classList.add('active');
    // Auto-scroll the timeline so the active card stays visible.
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Click anywhere on the card to seek (except the screenshot — that's the lightbox).
  events.addEventListener('click', function(e) {
    var shot = e.target.closest('.shot');
    if (shot && shot.tagName === 'IMG') {
      lightboxImg.src = shot.src;
      lightbox.classList.add('open');
      return;
    }
    var card = e.target.closest('.event');
    if (!card || !player) return;
    var t = parseInt(card.getAttribute('data-t'), 10) / 1000;
    player.currentTime = Math.max(0, t);
    // Pause at this point — don't auto-play, the user just wants to inspect.
    player.pause();
    setActive(card);
  });

  // While playing, highlight the most recent event whose timestamp the video has reached.
  if (player) {
    player.addEventListener('timeupdate', function() {
      var currentMs = player.currentTime * 1000;
      var match = null;
      for (var i = 0; i < index.length; i++) {
        if (index[i].t <= currentMs) match = index[i].el;
        else break;
      }
      if (match) setActive(match);
    });
  }

  lightbox.addEventListener('click', function() { lightbox.classList.remove('open'); });
})();
</script>
</body>
</html>`;
}

async function doSave() {
  const s = stamp();

  setBusy(true, 'Preparing…');
  setStatus('');

  try {
    if (selected === 'report') {
      // 1. Convert webm to base64 data URL (heavy step)
      setBusy(true, 'Embedding video…');
      let videoDataUrl = null;
      if (videoUrl) {
        // offscreen now hands us a data: URL directly; only convert if we somehow
        // still got a blob: URL (older path / fallback).
        videoDataUrl = videoUrl.startsWith('data:') ? videoUrl : await blobUrlToDataUrl(videoUrl);
      }

      // 2. Build HTML
      setBusy(true, 'Building report…');
      const html = buildReportHtml(videoDataUrl);
      // 3. Download from THIS page context via an <a> + object URL. (We can't route
      //    through the worker — it can't fetch our object URLs — and a multi-MB data:
      //    URL is heavier than a blob: URL for the same-context <a> download.)
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      setBusy(true, t('finishStatusSaving'));
      // Download via <a> since we have a same-page blob URL — background can't fetch our blob:.
      const a = document.createElement('a');
      a.href = url;
      a.download = `spotter-report-${s}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Keep URL alive briefly so the download can grab it, then revoke.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setStatus(t('finishStatusSaved'), 'success');
      setTimeout(close, 600);
      return;
    }

    // Video and/or events JSON. Download from THIS (page) context via <a>: the
    // worker can't fetch our object URLs, and a multi-MB video data: URL can choke
    // chrome.downloads. We build object URLs locally and click them.
    setBusy(true, t('finishStatusSaving'));
    const revokes = [];
    const downloadAnchor = (href, filename) => {
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    let did = false;
    if ((selected === 'both' || selected === 'video') && videoUrl) {
      // data: URL → binary blob → local object URL (keeps the .webm un-inflated).
      const blob = await (await fetch(videoUrl)).blob();
      const u = URL.createObjectURL(blob);
      revokes.push(u);
      downloadAnchor(u, `spotter-recording-${s}.webm`);
      did = true;
    }
    if (selected === 'both' || selected === 'history') {
      // Strip base64 screenshots — they bloat the JSON by megabytes and JSON's
      // job is metadata, not pixels. The HTML report keeps the screenshots.
      // hasScreenshot is preserved so consumers know an image existed.
      const leanEvents = history.map((ev) => {
        if (ev.screenshot) {
          const { screenshot, ...rest } = ev;
          return { ...rest, hasScreenshot: true };
        }
        return ev;
      });
      const payload = JSON.stringify(
        { generatedAt: new Date().toISOString(), environment, events: leanEvents },
        null,
        2
      );
      const u = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      revokes.push(u);
      downloadAnchor(u, `spotter-history-${s}.json`);
      did = true;
    }
    if (!did) {
      setBusy(false);
      setStatus(t('finishStatusNothingToSave'), 'error');
      return;
    }
    setTimeout(() => revokes.forEach((u) => URL.revokeObjectURL(u)), 30_000);
    setStatus(t('finishStatusSaved'), 'success');
    setTimeout(close, 600);
  } catch (err) {
    setBusy(false);
    setStatus(t('finishStatusFailed') + ': ' + (err.message || err), 'error');
  }
}

saveBtn.addEventListener('click', doSave);
cancelBtn.addEventListener('click', close);
