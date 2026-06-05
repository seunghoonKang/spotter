// Background service worker.
// - Owns recording state.
// - Spawns offscreen document for MediaRecorder (SW has no DOM).
// - Aggregates interaction history from content scripts and webNavigation.

const OFFSCREEN_URL = 'offscreen.html';
const MAX_DURATION_MS = 120_000; // Cap value (single source). Sent to content via RECORDING_STARTED; content's page timer is the primary enforcer, this SW runs a backup.

let recordingTabId = null;
let history = [];
let recordingStartTs = 0;
let maxDurationTimer = null;
let environment = null; // Captured once at recording start, surfaced in the report header.
// Dedupe map for console-error and network-error: key -> history index.
// When the same key recurs, increment the existing event's `count` instead of pushing a new row.
let dedupeKeys = new Map();
const MAX_DEDUPE_EVENTS = 100; // Hard cap so a runaway error loop can't blow up history.

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record tab audio/video via MediaRecorder.'
  });
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument();
  }
}

function relTs() {
  return Date.now() - recordingStartTs;
}

function scheduleMaxDurationTimer(remainingMs) {
  if (maxDurationTimer) clearTimeout(maxDurationTimer);
  // BACKUP enforcer only. The content script's page-context timer is the primary
  // stop (this SW setTimeout is unreliable — MV3 suspends the worker after ~30s
  // idle, discarding it). +1s so the content script's STOP_RECORDING wins when
  // the worker is alive; this just catches the case where content can't fire.
  maxDurationTimer = setTimeout(() => {
    if (recordingTabId != null) stopRecording().catch(console.error);
  }, remainingMs + 1000);
}

async function startRecording(streamId, tabId) {
  recordingTabId = tabId;
  history = [];
  recordingStartTs = Date.now();
  environment = null;
  dedupeKeys = new Map();

  await chrome.storage.local.set({ recording: true });
  await ensureOffscreen();

  // Tell offscreen doc to start with this streamId.
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    target: 'offscreen',
    streamId
  });

  // Inject the page-world hook so we can capture the PAGE's own console/fetch/XHR,
  // not just things in our isolated content-script world. world: 'MAIN' is the
  // MV3 way to reach the page's JS context (works on CSP-protected sites too).
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['page-hook.js']
    });
  } catch (e) {
    // chrome:// pages and a few other origins reject scripting — that's fine.
    console.warn('page-hook injection failed:', e);
  }

  // Seed history with the starting URL.
  try {
    const tab = await chrome.tabs.get(tabId);
    history.push({
      t: 0,
      kind: 'navigation',
      url: tab.url,
      title: tab.title
    });
  } catch {}

  // Tell content script to show overlay toolbar. If it's not there yet (e.g.
  // the user loaded the extension while this tab was already open and never
  // refreshed it), inject content.js directly and retry. Some pages
  // (chrome://, the Web Store) reject injection — bail cleanly in that case.
  let injected = false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED', maxDurationMs: MAX_DURATION_MS });
    injected = true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['spot-engine.js', 'content.js']
      });
      await chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED', maxDurationMs: MAX_DURATION_MS });
      injected = true;
    } catch (e2) {
      console.warn('content script injection failed:', e2);
    }
  }

  if (!injected) {
    // Can't show the toolbar — bail out cleanly instead of recording a stub.
    await chrome.storage.local.set({ recording: false });
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' }).catch(() => {});
    recordingTabId = null;
    throw new Error(chrome.i18n.getMessage('welcomeStartCantRun') || 'Spotter can\'t run on this page. Try a regular http(s) page.');
  }

  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ff3b30' });

  scheduleMaxDurationTimer(MAX_DURATION_MS);
}

async function stopRecording() {
  // Guard against double-stop: the content-script cap and the background backup
  // timer can both fire. The first run clears recordingTabId at the end; later
  // calls bail here so we don't re-stop the offscreen doc or re-show the dialog.
  if (recordingTabId == null) return;
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.storage.local.set({ recording: false });

  // Ask offscreen to stop and return blob URL.
  const result = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_STOP',
    target: 'offscreen'
  });

  // Wait for any in-flight screenshots to finish before shipping history.
  await captureQueue.catch(() => {});

  // Tell content script to hide overlay and show finish dialog.
  if (recordingTabId != null) {
    try {
      await chrome.tabs.sendMessage(recordingTabId, {
        type: 'RECORDING_STOPPED',
        videoUrl: result?.videoUrl || null,
        history: history.slice(),
        environment
      });
    } catch (e) {
      // Tab may be gone. Fall back to direct download of video only.
      if (result?.videoUrl) {
        chrome.downloads.download({ url: result.videoUrl, filename: 'spotter-recording.webm' });
      }
    }
  }

  recordingTabId = null;
  history = [];
  environment = null;
  dedupeKeys = new Map();

  // Close the offscreen document now. The video was handed off as a self-contained
  // data: URL (not a blob: URL tied to this document), so nothing still needs it.
  // Closing immediately also avoids a back-to-back hazard: a deferred close could
  // otherwise tear down a second recording started within the delay window.
  closeOffscreen();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen keep-alive ping: receiving it is enough to reset the worker's idle
  // timer so it survives the whole recording. No work to do.
  if (msg.type === 'KEEPALIVE') return false;
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'ENVIRONMENT') {
    // Captured once at recording start by content script.
    if (recordingTabId != null && sender.tab?.id === recordingTabId) {
      environment = msg.payload || null;
    }
    return false;
  }
  if (msg.type === 'PAGE_EVENT') {
    // console-error / network-error forwarded by content script from the page-world hook.
    if (recordingTabId != null && sender.tab?.id === recordingTabId) {
      addPageEvent(msg.payload);
    }
    return false;
  }
  if (msg.type === 'INTERACTION') {
    // From content script.
    if (recordingTabId != null && sender.tab?.id === recordingTabId) {
      const event = { t: relTs(), ...msg.payload };
      history.push(event);
      // If the content script already prepared a screenshot (e.g. for annotations,
      // where timing matters), use it directly. Otherwise capture after the fact.
      if (!event.screenshot && (event.kind === 'click' || event.kind === 'annotation')) {
        maybeCaptureScreenshot(event);
      }
    }
    return false;
  }
  if (msg.type === 'CAPTURE_NOW') {
    // Content script wants a screenshot RIGHT NOW (before the user scrolls / clears).
    // priority=true skips the inter-capture throttle so annotation timing stays accurate.
    captureNow({ priority: !!msg.priority }).then((dataUrl) => sendResponse({ dataUrl }));
    return true; // async response
  }
  if (msg.type === 'GET_HISTORY') {
    sendResponse({ history: history.slice(), environment });
    return false;
  }
});

// Add a console-error or network-error event with deduplication.
// Same (kind, key) pair: bump the existing event's count + lastT instead of pushing a new row.
function addPageEvent(payload) {
  if (!payload) return;
  const key = payload.kind === 'network-error'
    ? `net|${payload.method}|${payload.url}|${payload.status}`
    : `con|${payload.message}`;
  const existingIdx = dedupeKeys.get(key);
  if (existingIdx != null) {
    const ev = history[existingIdx];
    if (ev) {
      ev.count = (ev.count || 1) + 1;
      ev.lastT = relTs();
    }
    return;
  }
  if (dedupeKeys.size >= MAX_DEDUPE_EVENTS) return; // hard cap
  const event = { t: relTs(), count: 1, ...payload };
  history.push(event);
  dedupeKeys.set(key, history.length - 1);
}

// --- Screenshot capture ---
// captureVisibleTab is rate-limited to roughly 2/sec; throttle to be safe.
// Use a small queue so rapid calls are serialized rather than dropped.
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
const MIN_CAPTURE_GAP_MS = 500;

// Queue a capture and return the result (data URL or null).
// opts.priority=true: skip both the queue and the inter-capture wait so the call
// happens as soon as possible. Used for annotation captures where timing matters
// (the user is about to scroll and the strokes need to be caught NOW).
function captureNow(opts) {
  if (recordingTabId == null) return Promise.resolve(null);
  const tabId = recordingTabId;
  const priority = opts && opts.priority;

  const doCapture = async () => {
    if (!priority) {
      const now = Date.now();
      const wait = Math.max(0, MIN_CAPTURE_GAP_MS - (now - lastCaptureAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    lastCaptureAt = Date.now();
    try {
      const tab = await chrome.tabs.get(tabId);
      return await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 70
      });
    } catch (err) {
      return null;
    }
  };

  if (priority) {
    // Bypass the queue entirely.
    return doCapture();
  }
  const next = captureQueue.then(doCapture);
  captureQueue = next.catch(() => {});
  return next;
}

// Legacy path: attach a screenshot to an event in-place after the fact.
// Used for clicks (where capture-after is fine — ripple shows where the click happened).
function maybeCaptureScreenshot(event) {
  if (recordingTabId == null) return;
  captureNow().then((dataUrl) => {
    if (dataUrl) event.screenshot = dataUrl;
  }).catch(() => {});
}

// Track navigation events (full page loads) for the recording tab.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId !== recordingTabId) return;
  if (details.frameId !== 0) return; // top frame only
  history.push({
    t: relTs(),
    kind: 'navigation',
    url: details.url,
    transitionType: details.transitionType
  });
});

// SPA-style history changes.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.tabId !== recordingTabId) return;
  if (details.frameId !== 0) return;
  history.push({
    t: relTs(),
    kind: 'spa-navigation',
    url: details.url
  });
});

// If the recorded tab closes mid-recording, stop cleanly.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recordingTabId) {
    stopRecording().catch(console.error);
  }
});

// First-install welcome page. Only on fresh install — not on updates or browser
// startup, so existing users aren't pulled away from what they were doing.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
