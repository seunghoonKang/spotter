let recorder = null;
let chunks = [];
let currentStream = null;
let resolveStop = null;
let keepAlive = null; // pings the service worker so MV3 doesn't suspend it mid-recording

// While recording, the service worker holds the session state (recordingTabId,
// history). MV3 suspends the worker after ~30s idle, which would drop that state
// and break the stop/handoff. This offscreen document stays alive the whole
// recording (it's actively capturing media), so we ping the worker periodically
// to reset its idle timer. Receiving any message keeps the worker awake.
function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
  }, 20_000); // < the ~30s idle window
}
function stopKeepAlive() {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

async function start(streamId) {
  // Keep the capture at the tab's NATIVE resolution/aspect — do NOT set
  // maxWidth/maxHeight: with legacy tab-capture constraints, capping both forces a
  // square track (e.g. 1600×1600) and letterboxes the real content inside it.
  // File size is bounded by the recorder bitrate below, not resolution, so capping
  // resolution bought nothing and broke the aspect ratio. We only cap the frame
  // rate (bug repros read fine at 15fps and it trims bitrate pressure).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxFrameRate: 15
      }
    }
  });
  currentStream = stream;

  // tabCapture mutes the source tab's audio by default; pipe it back so the user still hears it.
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);

  chunks = [];
  // ~1.2 Mbps keeps 2 minutes near the size of the old 1-minute default while
  // staying sharp enough to read small UI text.
  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoBitsPerSecond: 1_200_000
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    stopKeepAlive();
    const blob = new Blob(chunks, { type: 'video/webm' });
    // Return a self-contained data: URL, NOT a blob: URL. A blob: URL created here
    // (offscreen document) can't be fetched from the finish-dialog iframe or the
    // worker — Chrome partitions blob URLs by context, so cross-context reads fail
    // with ERR_FILE_NOT_FOUND. The data: URL carries the bytes and works anywhere.
    const fr = new FileReader();
    const finish = (videoUrl) => {
      if (resolveStop) { resolveStop({ videoUrl }); resolveStop = null; }
      currentStream?.getTracks().forEach((t) => t.stop());
      currentStream = null;
      audioCtx.close().catch(() => {});
    };
    fr.onload = () => finish(fr.result);
    fr.onerror = () => finish(null);
    fr.readAsDataURL(blob);
  };
  recorder.start(1000);
  startKeepAlive();
}

function stop() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') {
      stopKeepAlive();
      resolve({ videoUrl: null });
      return;
    }
    resolveStop = resolve;
    recorder.stop();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'OFFSCREEN_START') {
    start(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stop().then((r) => sendResponse(r));
    return true;
  }
});
