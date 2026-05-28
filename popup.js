const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const hintEl = document.getElementById('hint');

// Static labels.
startBtn.textContent = t('popupBtnStart');
stopBtn.textContent = t('popupBtnStop');
// Hint contains a styled shortcut; use innerHTML and wrap the inserted
// shortcut in <b> so it visually pops the way the original prose did.
const shortcutHtml = '<b>⌘/Ctrl + Shift + S</b>';
hintEl.innerHTML = t('popupHint', [shortcutHtml]).replace(/\b1 minute\b/, '<b>1 minute</b>').replace(/1분/, '<b>1분</b>');

async function refreshState() {
  const { recording } = await chrome.storage.local.get('recording');
  if (recording) {
    statusEl.textContent = t('popupStatusRecording');
    statusEl.classList.add('recording');
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusEl.textContent = t('popupStatusIdle');
    statusEl.classList.remove('recording');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusEl.textContent = t('popupStatusStarting');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    statusEl.textContent = t('popupStatusNoTab');
    startBtn.disabled = false;
    return;
  }

  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(chrome.runtime.lastError || new Error('no streamId'));
        } else {
          resolve(id);
        }
      });
    });

    const res = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      streamId,
      tabId: tab.id
    });
    if (res?.ok === false) {
      statusEl.textContent = res.error || t('popupStatusFailed');
      startBtn.disabled = false;
      return;
    }
    window.close();
  } catch (err) {
    console.error(err);
    statusEl.textContent = t('popupStatusFailed') + ': ' + (err.message || err);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  statusEl.textContent = t('popupStatusStopping');
  await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  window.close();
});

refreshState();
