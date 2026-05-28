// Page-world hook script. Injected via chrome.scripting.executeScript({ world: 'MAIN' })
// so it runs in the page's JS context — letting us patch the page's own console,
// fetch, and XMLHttpRequest. From the page, we postMessage out to the content
// script (which lives in the isolated world) to forward to background.
//
// IDEMPOTENT: re-injecting is a no-op so repeated start/stop cycles are safe.
(function () {
  if (window.__spotterHooked) return;
  window.__spotterHooked = true;

  const TAG = '__spotter';

  function emit(payload) {
    try {
      window.postMessage({ source: TAG, payload }, '*');
    } catch (_) { /* ignore */ }
  }

  // Safely stringify an arg for the report. Avoid huge dumps.
  function describe(v) {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    try {
      const s = JSON.stringify(v);
      return s.length > 500 ? s.slice(0, 500) + '…' : s;
    } catch {
      return String(v);
    }
  }

  // --- console.error ---
  const origError = console.error.bind(console);
  console.error = function (...args) {
    emit({
      kind: 'console-error',
      message: args.map(describe).join(' ')
    });
    return origError(...args);
  };

  // --- uncaught errors ---
  window.addEventListener('error', (e) => {
    // Filter out resource load errors (img/script 404) — they're noisy and
    // already covered by the network hook below. e.target is the failing
    // resource for those; e.message is empty.
    if (!e.message && e.target && e.target !== window) return;
    emit({
      kind: 'console-error',
      message: e.message || 'Uncaught error',
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ''
    });
  }, true);

  // --- unhandled promise rejections ---
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    emit({
      kind: 'console-error',
      message: 'Unhandled rejection: ' + describe(r)
    });
  });

  // --- fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const method = (init && init.method) || (input && input.method) || 'GET';
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      return origFetch.apply(this, arguments).then((res) => {
        if (res && res.status >= 400) {
          emit({
            kind: 'network-error',
            method: method.toUpperCase(),
            url,
            status: res.status,
            statusText: res.statusText || ''
          });
        }
        return res;
      }, (err) => {
        emit({
          kind: 'network-error',
          method: method.toUpperCase(),
          url,
          status: 0,
          statusText: err && err.message ? err.message : 'fetch failed'
        });
        throw err;
      });
    };
  }

  // --- XMLHttpRequest ---
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__spotterMethod = (method || 'GET').toUpperCase();
      this.__spotterUrl = url || '';
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const xhr = this;
      const report = (status, statusText) => {
        emit({
          kind: 'network-error',
          method: xhr.__spotterMethod || 'GET',
          url: xhr.__spotterUrl || '',
          status: status || 0,
          statusText: statusText || ''
        });
      };
      xhr.addEventListener('load', () => {
        if (xhr.status >= 400) report(xhr.status, xhr.statusText);
      });
      xhr.addEventListener('error', () => report(0, 'network error'));
      xhr.addEventListener('abort', () => report(0, 'aborted'));
      xhr.addEventListener('timeout', () => report(0, 'timeout'));
      return origSend.apply(this, arguments);
    };
  }
})();
