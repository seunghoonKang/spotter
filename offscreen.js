let recorder = null;
let chunks = [];
let currentStream = null;
let resolveStop = null;

async function start(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
    },
    video: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
    }
  });
  currentStream = stream;

  // tabCapture mutes the source tab's audio by default; pipe it back so the user still hears it.
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(audioCtx.destination);

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    if (resolveStop) {
      resolveStop({ videoUrl: url });
      resolveStop = null;
    }
    currentStream?.getTracks().forEach((t) => t.stop());
    currentStream = null;
    audioCtx.close().catch(() => {});
  };
  recorder.start(1000);
}

function stop() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') {
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
