// Content script: runs in the page context.
// Responsibilities:
//   1. Show a floating toolbar while recording (toggle drawing, change color, clear, stop).
//   2. Drawing overlay canvas — pointer-events: auto in draw mode, none otherwise.
//   3. Capture meaningful clicks while NOT in draw mode and forward to background.
//   4. On stop, host the finish dialog iframe so the user picks export format.

(() => {
  if (window.__spotterInjected) return;
  window.__spotterInjected = true;

  // Recording cap, used here ONLY for the timer display (countdown + warning
  // colours). The authoritative cap lives in background.js, which enforces the
  // stop and ships the value via RECORDING_STARTED; this is just a fallback.
  let maxDurationMs = 120_000;
  const SHORTCUT_LABEL = '⌘/Ctrl + Shift + S';

  // Short i18n helper. Content scripts can call chrome.i18n.getMessage directly.
  function _(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  let root = null;       // Shadow host
  let shadow = null;
  let rippleCanvas = null;   // click-feedback ripples (the Spot engine owns the annotation canvases)
  let rippleCtx = null;
  let toolbar = null;
  let timerEl = null;
  let timerInterval = null;
  let recordingStartTs = 0;
  let hintPill = null;       // First-run hint pill above the toolbar.
  let spotEngine = null;     // Spot capture engine; created in createOverlay, owns the annotation surface.

  function createOverlay() {
    if (root) return;
    root = document.createElement('div');
    root.id = '__spotter-root';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483646;
      pointer-events: none;
    `;
    shadow = root.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .ripple {
        position: fixed; inset: 0;
        pointer-events: none;
      }
      .toolbar {
        position: fixed;
        bottom: 24px; left: 50%;
        transform: translateX(-50%);
        display: flex; align-items: center; gap: 6px;
        background: rgba(13, 18, 14, 0.92);
        backdrop-filter: blur(8px);
        border: 1px solid #1f2818;
        border-radius: 999px;
        padding: 6px 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        color: #e6f0e0;
        pointer-events: auto;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }
      .btn {
        background: transparent;
        border: 1px solid transparent;
        color: #e6f0e0;
        padding: 6px 10px;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        display: inline-flex; align-items: center; gap: 6px;
      }
      .btn:hover { background: #1f2818; }
      .btn.active {
        background: #a3e635; color: #0d120e;
      }
      .btn.stop {
        background: #ff3b30; color: #fff;
      }
      .btn.stop:hover { background: #ff5a4f; }
      .swatch {
        width: 20px; height: 20px; border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
      }
      .swatch.active { border-color: #e6f0e0; }
      .divider { width: 1px; height: 18px; background: #1f2818; margin: 0 4px; }
      .palette {
        display: none;
        align-items: center;
        gap: 6px;
      }
      .palette.open { display: inline-flex; }
      .rec-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #ff3b30;
        animation: pulse 1.4s infinite;
        display: inline-block;
      }
      .timer {
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        color: #e6f0e0;
        padding: 0 4px;
        letter-spacing: 0.02em;
      }
      .timer.warning { color: #facc15; }
      .timer.danger { color: #ff3b30; font-weight: 500; }
      .hint-pill {
        position: fixed;
        bottom: 76px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(13, 18, 14, 0.96);
        backdrop-filter: blur(8px);
        border: 1px solid #bef264;
        border-radius: 999px;
        padding: 8px 14px;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        color: #e6f0e0;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        pointer-events: auto;
        animation: hint-in 280ms ease-out;
      }
      .hint-pill .hint-arrow {
        position: absolute;
        bottom: -6px;
        left: 50%;
        transform: translateX(-50%) rotate(45deg);
        width: 10px;
        height: 10px;
        background: rgba(13, 18, 14, 0.96);
        border-right: 1px solid #bef264;
        border-bottom: 1px solid #bef264;
      }
      .hint-pill kbd {
        font-family: inherit;
        font-size: 11px;
        background: #1f2818;
        border: 1px solid #2a3520;
        border-radius: 3px;
        padding: 1px 5px;
        color: #bef264;
      }
      .hint-pill .hint-close {
        background: transparent;
        border: none;
        color: #8a9080;
        font-size: 14px;
        cursor: pointer;
        padding: 0 0 0 4px;
        line-height: 1;
      }
      .hint-pill .hint-close:hover { color: #e6f0e0; }
      @keyframes hint-in {
        from { opacity: 0; transform: translateX(-50%) translateY(6px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
    `;
    shadow.appendChild(style);

    // Spot engine owns the committed + preview canvases. It appends them to the
    // shadow now, so they stack below the ripple/toolbar created next. Everything
    // chrome-specific is injected, keeping the engine free of chrome.* (testable).
    spotEngine = createSpotEngine({
      mount: shadow,
      i18n: _,
      captureScreenshot: () =>
        chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', priority: true })
          .then((res) => res?.dataUrl || null)
          .catch(() => null),
      onSpot: (spot) =>
        chrome.runtime.sendMessage({ type: 'INTERACTION', payload: { kind: 'annotation', ...spot } }),
      onEnabledChange: (on) => {
        shadow?.querySelector('#annotateBtn')?.classList.toggle('active', on);
        const palette = shadow?.querySelector('#palette');
        if (palette) palette.classList.toggle('open', on);
        if (on && hintPill) dismissHint(); // user reached the action — hint did its job
      }
    });

    rippleCanvas = document.createElement('canvas');
    rippleCanvas.className = 'ripple';
    shadow.appendChild(rippleCanvas);
    rippleCtx = rippleCanvas.getContext('2d');

    resizeRipple();

    toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = `
      <span class="rec-dot" id="recDot"></span>
      <span class="timer" id="timer">00:00 / 02:00</span>
      <div class="divider"></div>
      <button class="btn" data-action="toggle-annotate" id="annotateBtn" title="${_('toolbarSpotTitle', [SHORTCUT_LABEL])}">${_('toolbarSpot')}</button>
      <div class="palette" id="palette">
        <div class="divider"></div>
        <div class="swatch active" data-color="#a3e635" style="background:#a3e635"></div>
        <div class="swatch" data-color="#facc15" style="background:#facc15"></div>
        <div class="swatch" data-color="#67e8f9" style="background:#67e8f9"></div>
        <div class="swatch" data-color="#ff3b30" style="background:#ff3b30"></div>
        <div class="swatch" data-color="#ffffff" style="background:#ffffff"></div>
      </div>
      <div class="divider"></div>
      <button class="btn stop" data-action="stop">${_('toolbarStop')}</button>
    `;
    shadow.appendChild(toolbar);
    timerEl = shadow.querySelector('#timer');
    startTimer();

    toolbar.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      const color = e.target.closest('[data-color]')?.dataset.color;
      if (action === 'toggle-annotate') {
        spotEngine?.toggle();
      } else if (action === 'stop') {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      } else if (color) {
        spotEngine?.setColor(color);
        shadow.querySelectorAll('.swatch').forEach((s) =>
          s.classList.toggle('active', s.dataset.color === color)
        );
      }
    });

    document.documentElement.appendChild(root);
    window.addEventListener('resize', resizeRipple);
    window.addEventListener('keydown', onSpotShortcut, true);
    maybeShowHint();
  }

  // First-run hint above the toolbar. Shows once per user (storage flag),
  // dismissed by either taking a spot, stopping the recording, or clicking ✕.
  async function maybeShowHint() {
    try {
      const { spotterHintShown } = await chrome.storage.local.get('spotterHintShown');
      if (spotterHintShown) return;
    } catch { return; }
    if (!shadow || hintPill) return;
    hintPill = document.createElement('div');
    hintPill.className = 'hint-pill';
    const kbdHtml = '<kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>';
    hintPill.innerHTML = `
      ${_('hintPillText', [kbdHtml])}
      <button class="hint-close" aria-label="Dismiss">✕</button>
      <div class="hint-arrow"></div>
    `;
    hintPill.querySelector('.hint-close').addEventListener('click', dismissHint);
    shadow.appendChild(hintPill);
  }

  function dismissHint() {
    if (hintPill) {
      hintPill.remove();
      hintPill = null;
    }
    // Set the flag regardless of how the hint was dismissed.
    chrome.storage.local.set({ spotterHintShown: true }).catch(() => {});
  }

  // Cmd/Ctrl + Shift + S toggles spot mode. Use capture phase + preventDefault
  // so the page's own handlers (e.g. Save / Save As) don't fire.
  function onSpotShortcut(e) {
    if (!root) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey) return;
    if (e.key !== 'S' && e.key !== 's') return;
    e.preventDefault();
    e.stopPropagation();
    spotEngine?.toggle();
  }

  function formatMMSS(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getElapsedMs() {
    return Date.now() - recordingStartTs;
  }

  function updateTimer() {
    if (!timerEl) return;
    const elapsed = getElapsedMs();
    const remaining = maxDurationMs - elapsed;
    timerEl.textContent = `${formatMMSS(elapsed)} / ${formatMMSS(maxDurationMs)}`;
    timerEl.classList.toggle('warning', remaining <= 15_000 && remaining > 5_000);
    timerEl.classList.toggle('danger', remaining <= 5_000);
    // This page-context timer is the PRIMARY cap enforcer: unlike a background
    // service-worker setTimeout (which MV3 kills after ~30s idle), setInterval
    // here keeps running. background.js owns the cap VALUE (sent via
    // RECORDING_STARTED) and runs a backup timer, but this is what reliably fires.
    if (elapsed >= maxDurationMs) {
      stopTimer();
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    }
  }

  function startTimer() {
    recordingStartTs = Date.now();
    updateTimer();
    timerInterval = setInterval(updateTimer, 250); // sub-second so the second flip looks crisp
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // Sizes the ripple (click-feedback) canvas to the viewport. The Spot engine
  // owns and sizes the annotation canvases itself.
  function resizeRipple() {
    if (rippleCanvas) {
      rippleCanvas.width = window.innerWidth;
      rippleCanvas.height = window.innerHeight;
    }
  }

  function removeOverlay() {
    if (!root) return;
    stopTimer();
    spotEngine?.destroy();
    spotEngine = null;
    // Mark hint as seen — by the time we stop, the user has been exposed enough.
    if (hintPill) dismissHint();
    window.removeEventListener('resize', resizeRipple);
    window.removeEventListener('keydown', onSpotShortcut, true);
    root.remove();
    root = shadow = toolbar = rippleCanvas = rippleCtx = timerEl = null;
    hintPill = null;
  }

  // ---- Click tracking ----
  // Capture phase so we see clicks before the page's handlers; only forward "meaningful" ones.
  function describeElement(el) {
    if (!el || el.nodeType !== 1) return null;

    // Walk up to find a semantic interactive ancestor (button, link, etc.).
    let cur = el;
    let interactive = null;
    while (cur && cur !== document.body) {
      const tag = cur.tagName?.toLowerCase();
      const role = cur.getAttribute?.('role');
      if (
        tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea' ||
        role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' ||
        cur.onclick != null
      ) {
        interactive = cur;
        break;
      }
      cur = cur.parentElement;
    }
    const target = interactive || el;

    const text = (target.innerText || target.value || target.getAttribute?.('aria-label') || '')
      .trim()
      .slice(0, 60);

    return {
      tag: target.tagName?.toLowerCase(),
      role: target.getAttribute?.('role') || null,
      ariaLabel: target.getAttribute?.('aria-label') || null,
      text,
      href: target.tagName === 'A' ? target.getAttribute('href') : null,
      selector: cssPath(target)
    };
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        part += '#' + el.id;
        parts.unshift(part);
        break;
      }
      if (el.classList.length) {
        part += '.' + Array.from(el.classList).slice(0, 2).join('.');
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function drawRipple(x, y) {
    if (!rippleCtx) return;
    const start = performance.now();
    const duration = 600;
    const maxRadius = 36;

    function frame(now) {
      const t = (now - start) / duration;
      if (t >= 1) {
        // Clear our region — only clear what we drew to avoid wiping concurrent ripples.
        rippleCtx.clearRect(x - maxRadius - 4, y - maxRadius - 4, (maxRadius + 4) * 2, (maxRadius + 4) * 2);
        return;
      }
      // Clear previous frame's region
      rippleCtx.clearRect(x - maxRadius - 4, y - maxRadius - 4, (maxRadius + 4) * 2, (maxRadius + 4) * 2);

      // Solid inner dot (fades out)
      rippleCtx.beginPath();
      rippleCtx.arc(x, y, 6, 0, Math.PI * 2);
      rippleCtx.fillStyle = `rgba(255, 45, 85, ${1 - t})`;
      rippleCtx.fill();

      // Expanding ring
      const r = 6 + (maxRadius - 6) * t;
      rippleCtx.beginPath();
      rippleCtx.arc(x, y, r, 0, Math.PI * 2);
      rippleCtx.strokeStyle = `rgba(255, 45, 85, ${1 - t})`;
      rippleCtx.lineWidth = 3;
      rippleCtx.stroke();

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Called right after resume. Paints a brief black fade into the ripple canvas
  // (which is in the recorded layer). This dampens the visual jump when the recording
  // resumes with newly-drawn annotations on screen — it reads as a quiet scene cut
  // rather than "everything appeared at once". Also pushes a history event for the timeline.
  function onClick(e) {
    // Ignore clicks on our own overlay.
    if (e.target === root || (root && root.contains(e.target))) return;
    // Ignore in Spot mode — the user is drawing a rectangle, not interacting with the page.
    if (spotEngine?.isEnabled()) return;

    const desc = describeElement(e.target);
    if (!desc) return;
    // Only forward if there's something descriptive — skip random div clicks with no text.
    if (!desc.text && !desc.ariaLabel && desc.tag !== 'button' && desc.tag !== 'a' &&
        desc.role !== 'button' && desc.role !== 'tab') {
      return;
    }

    // Visual feedback on the overlay (gets captured into the recording).
    drawRipple(e.clientX, e.clientY);

    chrome.runtime.sendMessage({
      type: 'INTERACTION',
      payload: {
        kind: 'click',
        element: desc,
        url: location.href,
        x: e.clientX,
        y: e.clientY
      }
    });
  }
  document.addEventListener('click', onClick, true);

  // ---- Messages from background ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RECORDING_STARTED') {
      if (typeof msg.maxDurationMs === 'number') maxDurationMs = msg.maxDurationMs;
      createOverlay();
      sendEnvironment();
      startPageEventBridge();
    } else if (msg.type === 'RECORDING_STOPPED') {
      removeOverlay();
      stopPageEventBridge();
      showFinishDialog(msg.videoUrl, msg.history, msg.environment);
    }
  });

  // ---- Environment snapshot ----
  // Collected once at recording start. Surfaced in the report header so the
  // dev receiving the report knows the browser/OS/viewport without asking.
  function sendEnvironment() {
    const ua = navigator.userAgent || '';
    const uaData = navigator.userAgentData; // Chromium; may be undefined
    let timezone = '';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {}
    const env = {
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
      language: navigator.language || '',
      timezone,
      ua,
      platform: uaData?.platform || (navigator.platform || ''),
      mobile: uaData?.mobile ?? false,
      brands: uaData?.brands?.map(b => `${b.brand} ${b.version}`).join(', ') || ''
    };
    chrome.runtime.sendMessage({ type: 'ENVIRONMENT', payload: env });
  }

  // ---- Bridge: page-world hook → background ----
  // page-hook.js postMessages to window with { source: '__spotter', payload }.
  // We forward each payload to background; dedup + history insert happen there.
  let pageEventListener = null;
  function startPageEventBridge() {
    if (pageEventListener) return;
    pageEventListener = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== '__spotter' || !d.payload) return;
      chrome.runtime.sendMessage({ type: 'PAGE_EVENT', payload: d.payload });
    };
    window.addEventListener('message', pageEventListener);
  }
  function stopPageEventBridge() {
    if (pageEventListener) {
      window.removeEventListener('message', pageEventListener);
      pageEventListener = null;
    }
  }

  // ---- Finish dialog ----
  function showFinishDialog(videoUrl, history, environment) {
    // Inject an iframe pointing at the extension's finish-dialog.html, passing data via postMessage.
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
    `;
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('finish-dialog.html');
    iframe.style.cssText = `
      width: 380px; height: 440px; border: 0; border-radius: 12px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
    `;
    wrap.appendChild(iframe);
    document.documentElement.appendChild(wrap);

    iframe.addEventListener('load', () => {
      iframe.contentWindow.postMessage({
        type: 'SPOTTER_FINISH_DATA',
        videoUrl,
        history,
        environment
      }, '*');
    });

    window.addEventListener('message', function handler(ev) {
      if (ev.source !== iframe.contentWindow) return;
      if (ev.data?.type === 'SPOTTER_FINISH_CLOSE') {
        window.removeEventListener('message', handler);
        wrap.remove();
      }
    });
  }
})();
