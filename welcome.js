// Welcome page is the one place we need an in-page language toggle —
// chrome.i18n.getMessage tracks the browser UI language but can't be
// overridden at runtime, so we keep a small parallel dictionary here.
// Other UI surfaces (popup, toolbar, report) still use chrome.i18n.

const KBD = '<kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>';
const KBD_ENTER = '<kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>';

const STRINGS = {
  en: {
    title: 'Welcome to Spotter',
    badge: 'Spotter is installed',
    headline: "Spot bugs while you browse.",
    tagline: "Record a tab. Flag what's broken. Hand off a single-file report.",
    step1Title: 'Click the Spotter icon → <span class="accent">Start recording</span>',
    step1Body: '<span class="rec-dot"></span>Recording is capped at 1 minute. Pin the icon in the toolbar (puzzle menu → 📌) so it\'s always one click away.',
    step2Title: 'Press ' + KBD + ' to spot something',
    step2Body: 'Your cursor becomes a reticle. Drag a box around the problem, type a note, then ' + KBD_ENTER + ' to confirm. Spot mode turns off automatically — press the shortcut again for the next one.',
    step3Title: 'Stop. Get a single-file <span class="accent">HTML report</span>.',
    step3Body: 'Video, every spot with a screenshot, every meaningful click, plus console errors and failed requests — all in one .html attachment. Open with one double-click.',
    cta: 'Try it now',
    footnote: 'Tip: if you opened a tab before installing Spotter, refresh it once. Spotter doesn\'t work on <code>chrome://</code> pages or the Chrome Web Store.'
  },
  ko: {
    title: 'Spotter에 오신 것을 환영합니다',
    badge: 'Spotter가 설치되었습니다',
    headline: '브라우징 중에 버그를 짚어내세요.',
    tagline: '탭을 녹화하고, 문제 지점을 표시하고, 단일 파일 리포트로 전달하세요.',
    step1Title: 'Spotter 아이콘 클릭 → <span class="accent">녹화 시작</span>',
    step1Body: '<span class="rec-dot"></span>녹화는 최대 1분까지. 툴바에 아이콘을 고정해두면(퍼즐 메뉴 → 📌) 클릭 한 번에 시작할 수 있습니다.',
    step2Title: KBD + ' 를 눌러 영역을 표시하세요',
    step2Body: '커서가 조준선으로 바뀝니다. 문제 영역을 드래그로 박스 치고, 메모를 입력한 뒤 ' + KBD_ENTER + ' 로 확정하세요. 표시 모드는 자동으로 꺼지니, 다음 영역은 단축키를 다시 누르면 됩니다.',
    step3Title: '정지하면 단일 파일 <span class="accent">HTML 리포트</span> 가 만들어집니다.',
    step3Body: '영상, 각 표시 영역의 스크린샷, 의미 있는 클릭, 콘솔 에러와 실패한 네트워크 요청까지 — 모두 하나의 .html 파일에 담깁니다. 더블클릭 한 번으로 열립니다.',
    cta: '지금 사용해보기',
    footnote: '팁: Spotter 설치 전에 열어둔 탭이 있다면 새로고침을 한 번 해주세요. <code>chrome://</code> 페이지나 Chrome 웹스토어에서는 동작하지 않습니다.'
  }
};

function pickInitialLang() {
  try {
    const saved = localStorage.getItem('spotterWelcomeLang');
    if (saved && STRINGS[saved]) return saved;
  } catch {}
  const browserLang = (navigator.language || 'en').toLowerCase();
  return browserLang.startsWith('ko') ? 'ko' : 'en';
}

function applyLang(lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  document.documentElement.lang = lang;
  document.title = dict.title;
  document.querySelectorAll('[data-i]').forEach((el) => {
    const key = el.getAttribute('data-i');
    if (dict[key] != null) el.innerHTML = dict[key];
  });
  document.querySelectorAll('#lang-toggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  try { localStorage.setItem('spotterWelcomeLang', lang); } catch {}
}

document.querySelectorAll('#lang-toggle button').forEach((b) => {
  b.addEventListener('click', () => applyLang(b.dataset.lang));
});

applyLang(pickInitialLang());

document.getElementById('start-btn').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://example.com' });
  const me = await chrome.tabs.getCurrent();
  if (me) chrome.tabs.remove(me.id);
});
