// Spot capture engine — the annotation surface of the recording overlay.
//
// Owns everything about placing a "Spot" (a flagged rectangle + note): its two
// canvases (committed + preview), the drag → rectangle → note → commit state
// machine, scroll-fade of placed Spots, resize, and commit-time screenshot
// orchestration. Loaded as a content script before content.js, which calls the
// factory below.
//
// The engine has ZERO chrome.* — everything extension-specific is injected, so
// the state machine and commit-payload assembly are testable without the
// extension runtime (pass a fake captureScreenshot + an onSpot collector).
//
//   createSpotEngine({ mount, captureScreenshot, onSpot, onEnabledChange, i18n })
//     mount            : ShadowRoot/Element to append the two canvases + styles into
//     captureScreenshot: () => Promise<dataUrl|null>   (adapter; never rejects in prod)
//     onSpot           : (spot) => void   spot = { url, text, screenshot? }
//     onEnabledChange  : (enabled) => void   fires whenever Spot mode toggles
//                        (incl. the auto-disable after a commit), so the toolbar can sync
//     i18n             : (key, subs?) => string   editor placeholder / button titles
//   →  { enable(), disable(), toggle(), isEnabled(), setColor(hex), destroy() }
//
self.createSpotEngine = function createSpotEngine(config) {
  config = config || {};
  const mount = config.mount;
  const captureScreenshot = config.captureScreenshot || (() => Promise.resolve(null));
  const onSpot = config.onSpot || (() => {});
  const onEnabledChange = config.onEnabledChange || (() => {});
  const _ = config.i18n || ((k) => k);

  const MIN_RECT_PX = 8;          // smaller rectangles are treated as accidental clicks
  // Annotations live in viewport coordinates. We treat scroll in two phases:
  //  1. Tiny scroll (>= CAPTURE_SCROLL_PX): track position for fade accounting.
  //  2. Larger scroll (>= FADE_SCROLL_PX): strokes no longer line up — fade them out.
  const CAPTURE_SCROLL_PX = 3;
  const FADE_SCROLL_PX = 40;
  // Committed Spots also fade on their own this long after the last commit, so they
  // don't linger forever on pages that never scroll. (The screenshot already froze
  // them; on-screen they only need to read for a moment in the video.)
  const AUTO_FADE_MS = 2500;

  // Reticle SVG used as the cursor in Spot mode. 32×32, hotspot at center (16,16).
  const RETICLE_CURSOR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'><circle cx='16' cy='16' r='11' stroke='%23a3e635' stroke-width='1.5'/><line x1='16' y1='2' x2='16' y2='7' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='16' y1='25' x2='16' y2='30' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='2' y1='16' x2='7' y2='16' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><line x1='25' y1='16' x2='30' y2='16' stroke='%23a3e635' stroke-width='1.5' stroke-linecap='round'/><circle cx='16' cy='16' r='2' fill='%23ff3b30'/></svg>`;
  const RETICLE_CURSOR_URL = `url("data:image/svg+xml;utf8,${RETICLE_CURSOR_SVG}") 16 16, crosshair`;

  // ---- internal state ----
  let canvas = null;        // committed annotations (finalized rectangles + text)
  let ctx = null;
  let previewCanvas = null; // in-progress rectangle while dragging; NOT recorded
  let previewCtx = null;
  let enabled = false;
  let currentColor = '#a3e635';
  let pendingAnnotation = null; // { startX, startY, x, y, w, h, editor: { el, input } }
  let dragging = false;
  let lastScrollY = 0, lastScrollX = 0, fadeAnchorY = 0, fadeAnchorX = 0;
  let fadingOut = false;
  let autoFadeTimer = null; // time-based fade of committed Spots (scroll-independent)

  // ---- styles (annotation-only; toolbar/ripple/hint styles live in the overlay) ----
  const style = document.createElement('style');
  style.textContent = `
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
    .text-editor {
      position: fixed;
      display: inline-flex; align-items: flex-end; gap: 4px;
      background: rgba(13, 18, 14, 0.96);
      backdrop-filter: blur(6px);
      border: 1px solid #1f2818;
      border-radius: 6px;
      padding: 4px;
      pointer-events: auto;
      box-sizing: border-box;
    }
    .text-editor * { box-sizing: border-box; }
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
  `;
  mount.appendChild(style);

  // ---- canvases ----
  canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  mount.appendChild(canvas);
  ctx = canvas.getContext('2d');

  previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'preview';
  mount.appendChild(previewCanvas);
  previewCtx = previewCanvas.getContext('2d');

  lastScrollY = window.scrollY;
  lastScrollX = window.scrollX;
  fadeAnchorY = window.scrollY;
  fadeAnchorX = window.scrollX;
  resize();

  // ---- pointer drag → rectangle ----
  // Only fire when the canvas has pointer-events: auto (Spot mode).
  function onPointerDown(e) {
    if (!enabled || pendingAnnotation) return;
    // Starting a fresh Spot: cancel any pending/in-flight auto-fade and clear the
    // committed canvas if it's mid-fade, so the new Spot isn't wiped or drawn onto
    // a fading (invisible) layer.
    wakeCanvas();
    dragging = true;
    // Hide the cursor while dragging — the box + corner brackets ARE the cursor now.
    canvas.style.cursor = 'none';
    pendingAnnotation = {
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY, w: 0, h: 0,
      editor: null
    };
  }
  function onPointerMove(e) {
    if (!dragging || !pendingAnnotation) return;
    const a = pendingAnnotation;
    a.x = Math.min(a.startX, e.clientX);
    a.y = Math.min(a.startY, e.clientY);
    a.w = Math.abs(e.clientX - a.startX);
    a.h = Math.abs(e.clientY - a.startY);
    drawPreviewRect();
  }
  function endDrag() {
    if (!dragging || !pendingAnnotation) return;
    dragging = false;
    // Restore the cursor — clearing the inline style lets the CSS reticle take over.
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
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointerleave', endDrag);
  window.addEventListener('resize', resize);
  window.addEventListener('scroll', onScroll, { passive: true });

  // Draws the in-progress rectangle on the preview canvas (not yet committed).
  function drawPreviewRect() {
    if (!previewCtx || !pendingAnnotation) return;
    const a = pendingAnnotation;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    previewCtx.save();
    previewCtx.strokeStyle = currentColor;
    previewCtx.lineWidth = 3;
    previewCtx.setLineDash([6, 4]); // dashed while still being drawn
    previewCtx.strokeRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3);
    previewCtx.restore();
    drawCornerBrackets(previewCtx, a.x, a.y, a.w, a.h, 1);
  }

  // Four corner brackets on the rectangle. `scale` lets the commit-pulse animate
  // them. Fixed Spotter signature lime, independent of the swatch, so they read
  // as the tool's UI layer rather than part of the box.
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
    const o = 5; // sit clearly outside the rect
    c.beginPath();
    c.moveTo(x - o, y - o + len); c.lineTo(x - o, y - o); c.lineTo(x - o + len, y - o);
    c.stroke();
    c.beginPath();
    c.moveTo(x + w + o - len, y - o); c.lineTo(x + w + o, y - o); c.lineTo(x + w + o, y - o + len);
    c.stroke();
    c.beginPath();
    c.moveTo(x + w + o, y + h + o - len); c.lineTo(x + w + o, y + h + o); c.lineTo(x + w + o - len, y + h + o);
    c.stroke();
    c.beginPath();
    c.moveTo(x - o + len, y + h + o); c.lineTo(x - o, y + h + o); c.lineTo(x - o, y + h + o - len);
    c.stroke();
    c.restore();
  }

  function clearPreview() {
    if (previewCtx) previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }

  // After the drag, open a small textarea attached to the rectangle. Positions
  // under by default, above if there isn't room, clamped horizontally. Auto-grows.
  function openAnnotationEditor() {
    if (!pendingAnnotation || !mount) return;
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
    mount.appendChild(editor);

    const input = editor.querySelector('textarea');
    const ok = editor.querySelector('.confirm');
    const cancel = editor.querySelector('.cancel');

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      positionEditor();
    }

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

  // Switch the preview rectangle from dashed (drawing) to solid (locked in).
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

  // OK / Enter: paint rect + text label onto the committed canvas, clear preview,
  // and capture a screenshot RIGHT NOW. Driven by a deterministic user action, so
  // the captured frame accurately reflects where the user marked.
  function commitAnnotation() {
    if (!pendingAnnotation || !ctx) return;
    const a = pendingAnnotation;
    const text = (a.editor?.input?.value || '').trim();
    if (!text) {
      // Refuse empty — the whole point is pairing rect with text.
      a.editor?.input?.focus();
      return;
    }

    // 1. Paint the rectangle onto the committed canvas.
    ctx.save();
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3);
    ctx.restore();

    // 2. Paint the text label as a pill below/above the rect. Multi-line aware.
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

    // 3. Tear down the editor (preview brackets get redrawn by the pulse below).
    a.editor?.el.remove();
    const committedRect = { x: a.x, y: a.y, w: a.w, h: a.h };
    pendingAnnotation = null;

    // 4. Auto-disable Spot mode — one spot per activation. (Also clears preview.)
    disable();

    // 5. Capture & emit — defer one frame so the painted rect+label is on screen.
    //    After the capture resolves, emit the Spot, play the pulse, and start the
    //    auto-fade countdown (so the Spot clears itself even without a scroll).
    requestAnimationFrame(() => {
      captureScreenshot().then((dataUrl) => {
        onSpot({ url: location.href, text, ...(dataUrl ? { screenshot: dataUrl } : {}) });
        playCommitPulse(committedRect);
        scheduleAutoFade();
      }).catch(() => {
        onSpot({ url: location.href, text });
        playCommitPulse(committedRect);
        scheduleAutoFade();
      });
    });
  }

  // Short "gotcha" pulse on the corner brackets, then clear the preview.
  function playCommitPulse(rect) {
    if (!previewCtx) return;
    const start = performance.now();
    const duration = 220;
    function frame(now) {
      if (!previewCtx) return; // engine torn down mid-animation
      const t = Math.min(1, (now - start) / duration);
      let scale;
      if (t < 0.4)      scale = 1 + (0.18 * (t / 0.4));
      else if (t < 0.7) scale = 1.18 - (0.28 * ((t - 0.4) / 0.3));
      else              scale = 0.9 + (0.1 * ((t - 0.7) / 0.3));
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewCtx.save();
      previewCtx.strokeStyle = currentColor;
      previewCtx.lineWidth = 3;
      previewCtx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3);
      previewCtx.restore();
      drawCornerBrackets(previewCtx, rect.x, rect.y, rect.w, rect.h, scale);
      if (t < 1) requestAnimationFrame(frame);
      else clearPreview();
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

  // Sizes the two engine canvases to the viewport, preserving committed strokes.
  function resize() {
    if (!canvas) return;
    const old = ctx ? canvas.toDataURL() : null;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (old && ctx) {
      const img = new Image();
      img.onload = () => ctx && ctx.drawImage(img, 0, 0);
      img.src = old;
    }
    if (previewCanvas) {
      previewCanvas.width = window.innerWidth;
      previewCanvas.height = window.innerHeight;
      if (pendingAnnotation) drawPreviewRect();
    }
  }

  function onScroll() {
    if (!canvas || !ctx || fadingOut) return;

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
    fadeCommitted();
  }

  // Fade the committed-Spot canvas out, then clear it. Shared by scroll-fade and
  // the time-based auto-fade. No-op if a fade is already running.
  function fadeCommitted() {
    if (!canvas || !ctx || fadingOut) return;
    clearAutoFadeTimer();
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

  // Committed Spots fade on their own AUTO_FADE_MS after the last commit, so they
  // don't persist forever on pages that never scroll. Reset on each new commit.
  function scheduleAutoFade() {
    clearAutoFadeTimer();
    autoFadeTimer = setTimeout(fadeCommitted, AUTO_FADE_MS);
  }
  function clearAutoFadeTimer() {
    if (autoFadeTimer) { clearTimeout(autoFadeTimer); autoFadeTimer = null; }
  }

  // Bring the committed canvas back to a clean, fully-visible state for a new Spot:
  // cancel any pending auto-fade and, if mid-fade, drop the fade + clear stale strokes
  // so the new Spot isn't drawn onto a fading (invisible) layer or wiped by it.
  function wakeCanvas() {
    clearAutoFadeTimer();
    if (fadingOut) {
      fadingOut = false;
      if (canvas) canvas.classList.remove('fading');
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // ---- public interface ----
  // (function declarations so commitAnnotation can call disable() above.)
  function setEnabled(on) {
    enabled = on;
    if (!on) {
      // Cancel any in-progress drag/editor when leaving the mode.
      dragging = false;
      if (canvas) canvas.style.cursor = '';
      cancelAnnotation();
    }
    if (canvas) canvas.classList.toggle('annotate', enabled);
    onEnabledChange(enabled);
  }
  function enable() { setEnabled(true); }
  function disable() { setEnabled(false); }
  function toggle() { setEnabled(!enabled); }
  function isEnabled() { return enabled; }
  function setColor(hex) { currentColor = hex; }
  function destroy() {
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll);
    clearAutoFadeTimer();
    cancelAnnotation();
    // Canvases/style are children of `mount`; the caller removes mount itself.
    canvas = ctx = previewCanvas = previewCtx = null;
    pendingAnnotation = null;
    dragging = false;
    enabled = false;
  }

  return { enable, disable, toggle, isEnabled, setColor, destroy };
};
