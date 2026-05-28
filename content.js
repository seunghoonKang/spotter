// Content script: runs in the page context.
// Responsibilities:
//   1. Show a floating toolbar while recording (toggle drawing, change color, clear, stop).
//   2. Drawing overlay canvas — pointer-events: auto in draw mode, none otherwise.
//   3. Capture meaningful clicks while NOT in draw mode and forward to background.
//   4. On stop, host the finish dialog iframe so the user picks export format.

(() => {
  if (window.__spotterInjected) return;
  window.__spotterInjected = true;

  const MAX_DURATION_MS = 60_000; // 1 minute hard cap
  const MIN_RECT_PX = 8;          // smaller rectangles are treated as accidental clicks
  const SHORTCUT_LABEL = '⌘/Ctrl + Shift + S';

  // Short i18n helper. Content scripts can call chrome.i18n.getMessage directly.
  function _(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  // Reticle SVG used as the cursor when Spot mode is active. 32×32 with hotspot
  // at the center (16, 16) — the dead center of the crosshair is what gets dropped.
  const RETICLE_CURSOR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'><circle cx='16' cy='16' r='11' stroke='%23a3e635' stroke-width='1.5'/><line x1='16' y1='2' x2='16' y2='7' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='16' y1='25' x2='16' y2='30' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='2' y1='16' x2='7' y2='16' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='25' y1='16' x2='30' y2='16' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><circle cx='16' cy='16' r='2' fill='%23ff3b30'/></svg>`;
  const RETICLE_CURSOR_URL = `url("data:image/svg+xml;utf8,${RETICLE_CURSOR_SVG}") 16 16, crosshair`;

  let root = null;       // Shadow host
  let shadow = null;
  let canvas = null;     // committed annotations layer (finalized rectangles + text)
  let ctx = null;
  let previewCanvas = null; // shows the rectangle while dragging; NOT recorded into history
  let previewCtx = null;
  let rippleCanvas = null;
  let rippleCtx = null;
  let annotateMode = false;
  let currentColor = '#a3e635';
  let toolbar = null;
  let timerEl = null;
  let timerInterval = null;
  let recordingStartTs = 0;
  let hintPill = null;       // First-run hint pill above the toolbar.
  let lastScrollY = 0;
  let lastScrollX = 0;
  let fadeAnchorY = 0;
  let fadeAnchorX = 0;

  // In-progress annotation state.
  // When the user drags out a rectangle, we hold it here until they type a label
  // and confirm. The drawing happens on previewCanvas; only on commit do we paint
  // it onto the committed canvas and capture a screenshot.
  let pendingAnnotation = null; // { startX, startY, x, y, w, h, editor: { el, input } }
  let dragging = false;

  function createOverlay() {
    if (root) return;
    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;
    fadeAnchorY = window.scrollY;
    fadeAnchorX = window.scrollX;
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
      .canvas {
        position: fixed; inset: 0;
        pointer-events: none;
        transition: opacity 250ms ease-out;
      }
      .canvas.annotate {
        pointer-events: auto;
        cursor: ${RETICLE_CURSOR_URL};
      }
      .canvas.fading {
        opacity: 0;
      }
      .preview {
        position: fixed; inset: 0;
        pointer-events: none;
      }
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
      .text-editor {
        position: fixed;
        display: inline-flex; align-items: flex-end; gap: 4px;
        background: rgba(13, 18, 14, 0.96);
        backdrop-filter: blur(6px);
        border: 1px solid #1f2818;
        border-radius: 6px;
        padding: 4px;
        pointer-events: auto;
      }
      .text-editor textarea {
        background: transparent;
        border: none;
        outline: none;
        color: #e6f0e0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        font-size: 15px;
        font-weight: 500;
        padding: 6px 8px;
        min-width: 180px;
        max-width: 360px;
        min-height: 22px;
        max-height: 160px;
        line-height: 1.4;
        resize: none;
        overflow-y: auto;
      }
      .text-editor .confirm,
      .text-editor .cancel {
        background: transparent;
        border: 1px solid transparent;
        color: #e6f0e0;
        font-family: inherit;
        font-size: 14px;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        align-self: flex-end;
        margin-bottom: 2px;
      }
      .text-editor .confirm { color: #bef264; }
      .text-editor .confirm:hover { background: rgba(163, 230, 53, 0.14); }
      .text-editor .cancel { color: #8a9080; }
      .text-editor .cancel:hover { background: #1f2818; }
      .text-editor .hint {
        font-size: 10px;
        color: #8a9080;
        padding: 0 6px 4px 8px;
        align-self: flex-end;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.03em;
        white-space: nowrap;
        margin-bottom: 2px;
      }
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

    canvas = document.createElement('canvas');
    canvas.className = 'canvas';
    shadow.appendChild(canvas);
    ctx = canvas.getContext('2d');

    previewCanvas = document.createElement('canvas');
    previewCanvas.className = 'preview';
    shadow.appendChild(previewCanvas);
    previewCtx = previewCanvas.getContext('2d');

    rippleCanvas = document.createElement('canvas');
    rippleCanvas.className = 'ripple';
    shadow.appendChild(rippleCanvas);
    rippleCtx = rippleCanvas.getContext('2d');

    resizeCanvas();

    toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = `
      <span class="rec-dot" id="recDot"></span>
      <span class="timer" id="timer">00:00 / 01:00</span>
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
        setAnnotateMode(!annotateMode);
      } else if (action === 'stop') {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      } else if (color) {
        currentColor = color;
        shadow.querySelectorAll('.swatch').forEach((s) =>
          s.classList.toggle('active', s.dataset.color === color)
        );
      }
    });

    // Rectangle drag handlers — only fire when canvas has pointer-events: auto (annotate mode).
    canvas.addEventListener('pointerdown', (e) => {
      if (!annotateMode || pendingAnnotation) return;
      dragging = true;
      // Hide the cursor while dragging — the box + corner brackets ARE the cursor now.
      canvas.style.cursor = 'none';
      pendingAnnotation = {
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        w: 0,
        h: 0,
        editor: null
      };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !pendingAnnotation) return;
      const a = pendingAnnotation;
      a.x = Math.min(a.startX, e.clientX);
      a.y = Math.min(a.startY, e.clientY);
      a.w = Math.abs(e.clientX - a.startX);
      a.h = Math.abs(e.clientY - a.startY);
      drawPreviewRect();
    });
    const endDrag = (e) => {
      if (!dragging || !pendingAnnotation) return;
      dragging = false;
      // Restore the cursor — clearing the inline style lets the CSS reticle take over again.
      canvas.style.cursor = '';
      const a = pendingAnnotation;
      // Ignore accidental clicks / tiny drags.
      if (a.w < MIN_RECT_PX || a.h < MIN_RECT_PX) {
        clearPreview();
        pendingAnnotation = null;
        return;
      }
      // Rectangle finalized (still on preview canvas). Now prompt for text.
      openAnnotationEditor();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointerleave', endDrag);

    document.documentElement.appendChild(root);
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('scroll', onScroll, { passive: true });
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
    setAnnotateMode(!annotateMode);
  }

  // Annotations live in viewport coordinates. We treat scroll in two phases:
  //  1. Tiny scroll (>= CAPTURE_SCROLL_PX): grab a capture now while strokes are still visible
  //     in roughly the position they were drawn. The user clearly moved with intent.
  //  2. Larger scroll (>= FADE_SCROLL_PX): the strokes no longer line up with the page —
  //     fade them out so they don't lie about what they're pointing at.
  const CAPTURE_SCROLL_PX = 3;
  const FADE_SCROLL_PX = 40;
  let fadingOut = false;

  function onScroll() {
    if (!canvas || !ctx || fadingOut) return;

    // Track current position for fade-threshold accounting.
    const capDy = Math.abs(window.scrollY - lastScrollY);
    const capDx = Math.abs(window.scrollX - lastScrollX);
    if (capDy >= CAPTURE_SCROLL_PX || capDx >= CAPTURE_SCROLL_PX) {
      lastScrollY = window.scrollY;
      lastScrollX = window.scrollX;
    }

    // After enough drift, the existing annotations no longer line up with the
    // page underneath — fade them out, and cancel any in-progress annotation.
    const fadeDy = Math.abs(window.scrollY - fadeAnchorY);
    const fadeDx = Math.abs(window.scrollX - fadeAnchorX);
    if (fadeDy < FADE_SCROLL_PX && fadeDx < FADE_SCROLL_PX) return;
    fadeAnchorY = window.scrollY;
    fadeAnchorX = window.scrollX;

    cancelAnnotation();

    fadingOut = true;
    canvas.classList.add('fading');
    const c = canvas;
    const cctx = ctx;
    setTimeout(() => {
      if (!c || !cctx) { fadingOut = false; return; }
      cctx.clearRect(0, 0, c.width, c.height);
      c.classList.remove('fading');
      fadingOut = false;
    }, 260); // matches the CSS transition (250ms) + small buffer
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
    const remaining = MAX_DURATION_MS - elapsed;
    timerEl.textContent = `${formatMMSS(elapsed)} / ${formatMMSS(MAX_DURATION_MS)}`;
    timerEl.classList.toggle('warning', remaining <= 15_000 && remaining > 5_000);
    timerEl.classList.toggle('danger', remaining <= 5_000);
    if (elapsed >= MAX_DURATION_MS) {
      // Auto-stop. Background will run the same flow as a manual stop.
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

  function updatePaletteVisibility() {
    const palette = shadow?.querySelector('#palette');
    if (palette) palette.classList.toggle('open', annotateMode);
  }

  function setAnnotateMode(on) {
    annotateMode = on;
    if (on && hintPill) {
      // User reached the action — hint has done its job.
      dismissHint();
    }
    if (!on) {
      // Cancel any in-progress drag/editor when leaving the mode.
      dragging = false;
      if (canvas) canvas.style.cursor = '';
      cancelAnnotation();
    }
    canvas?.classList.toggle('annotate', annotateMode);
    shadow?.querySelector('#annotateBtn')?.classList.toggle('active', annotateMode);
    updatePaletteVisibility();
  }

  // Draws the in-progress rectangle on the preview canvas (not yet committed).
  function drawPreviewRect() {
    if (!previewCtx || !pendingAnnotation) return;
    const a = pendingAnnotation;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    previewCtx.save();
    previewCtx.strokeStyle = currentColor;
    previewCtx.lineWidth = 3;
    // Dashed while still being drawn, to feel "in progress".
    previewCtx.setLineDash([6, 4]);
    previewCtx.strokeRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3);
    previewCtx.restore();
    // Corner brackets — the cursor "becomes" the box. Drawn solid so they
    // stand out against the dashed rect.
    drawCornerBrackets(previewCtx, a.x, a.y, a.w, a.h, 1);
  }

  // Draw four corner brackets on the rectangle at (x, y, w, h).
  // `scale` lets the commit-pulse animate them between 0.85 → 1.15 → 1.
  // Bracket arm length is min(rect side / 4, 14px), clamped down for tiny rects.
  // Color is the fixed Spotter signature lime (#bef264) — one shade brighter
  // than the box, and independent of the swatch, so brackets feel like the
  // tool's UI layer rather than an extension of the box.
  function drawCornerBrackets(c, x, y, w, h, scale) {
    if (!c) return;
    const baseLen = Math.min(Math.min(w, h) / 4, 14);
    const len = Math.max(3, baseLen * scale);
    const lw = 3;
    c.save();
    c.strokeStyle = '#bef264';
    c.lineWidth = lw;
    c.lineCap = 'square';
    c.setLineDash([]);
    // Sit clearly outside the rect — separation gives the brackets their own
    // visual layer instead of reading as the box's corners.
    const o = 5;
    // Top-left
    c.beginPath();
    c.moveTo(x - o, y - o + len); c.lineTo(x - o, y - o); c.lineTo(x - o + len, y - o);
    c.stroke();
    // Top-right
    c.beginPath();
    c.moveTo(x + w + o - len, y - o); c.lineTo(x + w + o, y - o); c.lineTo(x + w + o, y - o + len);
    c.stroke();
    // Bottom-right
    c.beginPath();
    c.moveTo(x + w + o, y + h + o - len); c.lineTo(x + w + o, y + h + o); c.lineTo(x + w + o - len, y + h + o);
    c.stroke();
    // Bottom-left
    c.beginPath();
    c.moveTo(x - o + len, y + h + o); c.lineTo(x - o, y + h + o); c.lineTo(x - o, y + h + o - len);
    c.stroke();
    c.restore();
  }

  function clearPreview() {
    if (previewCtx) previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }

  // After the user finishes dragging a rectangle, open a small textarea
  // attached to it. Choose a sensible position (under by default, above if
  // there isn't room, clamped horizontally). Auto-grows as the user types.
  function openAnnotationEditor() {
    if (!pendingAnnotation || !shadow) return;
    // Switch the preview rect to a solid border now that the shape is locked in.
    drawPreviewRectSolid();

    const a = pendingAnnotation;
    const editor = document.createElement('div');
    editor.className = 'text-editor';
    editor.innerHTML = `
      <textarea rows="1" placeholder="${_('editorPlaceholder')}"></textarea>
      <span class="hint">⌘/Ctrl+↵</span>
      <button class="confirm" title="${_('editorConfirmTitle')}">OK</button>
      <button class="cancel" title="${_('editorCancelTitle')}">✕</button>
    `;
    shadow.appendChild(editor);

    const input = editor.querySelector('textarea');
    const ok = editor.querySelector('.confirm');
    const cancel = editor.querySelector('.cancel');

    // Auto-grow: resize textarea to fit content, then reposition the editor.
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      positionEditor();
    }

    // Position the editor relative to the rectangle. Recomputed on grow.
    function positionEditor() {
      const ew = editor.offsetWidth || 280;
      const eh = editor.offsetHeight || 40;
      const margin = 8;
      let left = a.x;
      let top = a.y + a.h + margin;
      if (top + eh > window.innerHeight - 8) {
        top = a.y - eh - margin; // above the rect
      }
      if (top < 8) top = 8;
      left = Math.max(8, Math.min(left, window.innerWidth - ew - 8));
      editor.style.left = left + 'px';
      editor.style.top = top + 'px';
    }

    requestAnimationFrame(positionEditor);

    a.editor = { el: editor, input };

    input.focus();
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      // Cmd/Ctrl + Enter confirms. Plain Enter inserts a newline (default).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commitAnnotation();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelAnnotation();
      }
      e.stopPropagation();
    });
    ok.addEventListener('click', commitAnnotation);
    cancel.addEventListener('click', cancelAnnotation);
  }

  // Switch the preview rectangle from dashed (drawing) to solid (locked in,
  // awaiting text).
  function drawPreviewRectSolid() {
    if (!previewCtx || !pendingAnnotation) return;
    const a = pendingAnnotation;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    previewCtx.save();
    previewCtx.strokeStyle = currentColor;
    previewCtx.lineWidth = 3;
    previewCtx.strokeRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3);
    previewCtx.restore();
    drawCornerBrackets(previewCtx, a.x, a.y, a.w, a.h, 1);
  }

  function cancelAnnotation() {
    if (pendingAnnotation?.editor) {
      pendingAnnotation.editor.el.remove();
    }
    pendingAnnotation = null;
    dragging = false;
    if (canvas) canvas.style.cursor = '';
    clearPreview();
  }

  // The user pressed OK / Enter. Paint the rectangle + text label onto the
  // committed canvas, clear the preview, and capture a screenshot RIGHT NOW.
  // Because we drive the capture from a deterministic user action (the click on OK),
  // and the rectangle was already on screen during dragging, the captured frame
  // accurately reflects where the user marked.
  function commitAnnotation() {
    if (!pendingAnnotation || !ctx) return;
    const a = pendingAnnotation;
    const text = (a.editor?.input?.value || '').trim();
    if (!text) {
      // Refuse empty — that's the whole point of pairing rect with text.
      a.editor?.input?.focus();
      return;
    }

    // 1. Paint the rectangle onto the committed canvas.
    ctx.save();
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3);
    ctx.restore();

    // 2. Paint the text label as a pill below/above the rect (same heuristic as editor).
    //    Supports multi-line text — each \n becomes a new line in the pill.
    ctx.save();
    const fontSize = 14;
    const lineHeight = 18;
    ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    const lines = text.split('\n');
    const padX = 10, padY = 6;
    const maxLineWidth = lines.reduce((m, ln) => Math.max(m, ctx.measureText(ln).width), 0);
    const lw = maxLineWidth + padX * 2;
    const lh = lineHeight * lines.length + padY * 2;
    let lx = a.x;
    let ly = a.y + a.h + 6;
    if (ly + lh > window.innerHeight - 4) ly = a.y - lh - 6;
    if (ly < 4) ly = 4;
    lx = Math.max(4, Math.min(lx, window.innerWidth - lw - 4));
    ctx.fillStyle = 'rgba(13, 18, 14, 0.92)';
    roundRect(ctx, lx, ly, lw, lh, 4);
    ctx.fill();
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = 1;
    roundRect(ctx, lx, ly, lw, lh, 4);
    ctx.stroke();
    ctx.fillStyle = currentColor;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, lx + padX, ly + padY + i * lineHeight + (lineHeight - fontSize) / 2);
    });
    ctx.restore();

    // 3. Tear down the editor (but keep preview brackets up for the pulse animation).
    a.editor?.el.remove();
    const committedRect = { x: a.x, y: a.y, w: a.w, h: a.h };
    pendingAnnotation = null;

    // 4. Auto-disable spot mode — one spot per activation. User must press shortcut/button again.
    setAnnotateMode(false);

    // 5. Capture & history — defer one frame so the painted rect+label is on screen.
    //    After the capture resolves, play the bracket pulse, then clear the preview.
    requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', priority: true }).then((res) => {
        chrome.runtime.sendMessage({
          type: 'INTERACTION',
          payload: {
            kind: 'annotation',
            url: location.href,
            text,
            ...(res?.dataUrl ? { screenshot: res.dataUrl } : {})
          }
        });
        playCommitPulse(committedRect);
      }).catch(() => {
        chrome.runtime.sendMessage({
          type: 'INTERACTION',
          payload: { kind: 'annotation', url: location.href, text }
        });
        playCommitPulse(committedRect);
      });
    });
  }

  // Short "gotcha" pulse on the corner brackets, then clear the preview.
  // Runs after the screenshot so the brackets don't shift mid-capture.
  function playCommitPulse(rect) {
    if (!previewCtx) return;
    const start = performance.now();
    const duration = 220;
    function frame(now) {
      if (!previewCtx) return; // overlay torn down mid-animation
      const t = Math.min(1, (now - start) / duration);
      // Three-stage scale: 1 → 1.18 → 0.9 → 1, then clear.
      let scale;
      if (t < 0.4)      scale = 1 + (0.18 * (t / 0.4));
      else if (t < 0.7) scale = 1.18 - (0.28 * ((t - 0.4) / 0.3));
      else              scale = 0.9 + (0.1 * ((t - 0.7) / 0.3));
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      // Redraw the solid rect underneath so the brackets still "wrap" something.
      previewCtx.save();
      previewCtx.strokeStyle = currentColor;
      previewCtx.lineWidth = 3;
      previewCtx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3);
      previewCtx.restore();
      drawCornerBrackets(previewCtx, rect.x, rect.y, rect.w, rect.h, scale);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        clearPreview();
      }
    }
    requestAnimationFrame(frame);
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function resizeCanvas() {
    if (!canvas) return;
    // Preserve existing committed annotations on resize.
    const old = ctx ? canvas.toDataURL() : null;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (old && ctx) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = old;
    }
    if (previewCanvas) {
      previewCanvas.width = window.innerWidth;
      previewCanvas.height = window.innerHeight;
      // Redraw the in-progress rectangle if any.
      if (pendingAnnotation) drawPreviewRect();
    }
    if (rippleCanvas) {
      rippleCanvas.width = window.innerWidth;
      rippleCanvas.height = window.innerHeight;
    }
  }

  function removeOverlay() {
    if (!root) return;
    stopTimer();
    cancelAnnotation();
    // Mark hint as seen — by the time we stop, the user has been exposed enough.
    if (hintPill) dismissHint();
    window.removeEventListener('resize', resizeCanvas);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('keydown', onSpotShortcut, true);
    root.remove();
    root = shadow = canvas = ctx = previewCanvas = previewCtx = toolbar = rippleCanvas = rippleCtx = timerEl = null;
    annotateMode = false;
    dragging = false;
    pendingAnnotation = null;
    hintPill = null;
    lastScrollY = 0;
    lastScrollX = 0;
    fadeAnchorY = 0;
    fadeAnchorX = 0;
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
    // Ignore in annotate mode — the user is drawing a rectangle, not interacting with the page.
    if (annotateMode) return;

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
