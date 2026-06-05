# Spotter — domain & architecture context

Spotter is a Chrome extension (MV3) for QA bug-reporting: record a tab, flag what's
broken, hand off a single self-contained HTML report. This file names the domain
concepts and the architectural seams so changes land in the right module.

## Domain vocabulary

- **Recording session** — the span from Start to Stop. `background.js` owns its state
  (which tab, history, environment) and the duration-cap **value**, which it ships to
  content via `RECORDING_STARTED` (`maxDurationMs`). Cap **enforcement** is primarily the
  content script's page-context timer (`setInterval` survives MV3 service-worker
  suspension); `background.js` runs a backup `setTimeout` (unreliable alone — MV3 kills
  the worker after ~30s idle, so it must not be the only enforcer). See ADR below.
- **Spot** — a flagged annotation: a rectangle the user drags over a problem plus a
  short note, captured together with a screenshot at commit time. Surfaced in the
  report as a `kind: 'annotation'` history event. (UI/i18n call it "Spot".)
- **Interaction history** — the time-ordered list of events (`navigation`, `click`,
  `input`, `submit`, `annotation`/Spot, `console-error`, `network-error`) aggregated in
  `background.js` and rendered as the report timeline by `finish-dialog.js`.
- **Overlay** — the in-page recording chrome: floating toolbar (Spot button, colour
  palette, timer, stop), the click-ripple feedback canvas, and the first-run hint.
  Lives in `content.js`; hosts the Spot engine.

## Architectural seams

- **Spot engine** (`spot-engine.js`, `createSpotEngine`) — a deep module owning the whole
  annotation surface: its two canvases (committed + preview), the
  drag → rectangle → note → commit state machine, scroll-fade of placed Spots, resize,
  and commit-time screenshot orchestration. Interface:
  `{ enable, disable, toggle, isEnabled, setColor, destroy }`.
  Everything extension-specific is **injected** — `captureScreenshot()`, `onSpot(spot)`,
  `onEnabledChange(enabled)`, `i18n(key)` — so the engine has **zero `chrome.*`** and its
  state machine + commit-payload assembly are testable in a plain DOM (no extension runtime).
  `content.js` is the adapter layer: it wires `captureScreenshot` → `CAPTURE_NOW`,
  `onSpot` → `INTERACTION`, and `onEnabledChange` → toolbar button/palette + hint.

- **content ↔ background message protocol** — implicit, via `chrome.runtime` string-typed
  messages (`RECORDING_STARTED`, `STOP_RECORDING`, `INTERACTION`, `CAPTURE_NOW`,
  `PAGE_EVENT`, `ENVIRONMENT`, `DOWNLOAD`, `RECORDING_STOPPED`). No single module owns it
  yet; grep the type string to find both ends.

- **Page-world hook** (`page-hook.js`) — injected into the page's MAIN world to patch the
  page's own `console.error`/`fetch`/`XHR`; bridges errors to content via `window.postMessage`,
  which forwards them as `PAGE_EVENT`.
