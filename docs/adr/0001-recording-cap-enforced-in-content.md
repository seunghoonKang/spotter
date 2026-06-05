# 1. Recording duration cap is enforced in the content script, not the background worker

Date: 2026-06-04
Status: Accepted

## Context

Recording is capped (currently 2 minutes). Enforcement was historically done in two
places: the content script's page-context timer (`setInterval` in `content.js`) sent
`STOP_RECORDING` at the cap, and `background.js` ran a backup `setTimeout`.

A "deepening" refactor consolidated this to a single owner — background.js as the sole
enforcer — on the reasoning that one invariant should live in one place, and the
content timer was "redundant display logic."

This broke the cap: recordings no longer stopped when the user was idle. Root cause is
the **MV3 service-worker lifecycle** — the background worker is suspended after ~30s of
no events, which discards any pending `setTimeout`. During an *active* recording the
worker stays warm (messages keep resetting the idle timer), so the bug only surfaced on
passive recordings (user watching, not interacting) — exactly when no events flow.

The content script's `setInterval` runs in the page, which is **not** subject to
service-worker suspension, so it fires reliably regardless of user activity.

## Decision

The **content script's page-context timer is the primary cap enforcer.** `background.js`
owns the cap *value* (single source, shipped to content via `RECORDING_STARTED` →
`maxDurationMs`) and runs a `setTimeout` **backup only** (with a +1s grace so content
wins when the worker is alive). The two enforcers are deliberate defense-in-depth, not
accidental duplication.

## Consequences

- Do not "consolidate" cap enforcement into a background-worker `setTimeout`. In MV3 any
  delayed background action that must survive worker suspension needs a persistent
  driver — a page-context timer (as here) or `chrome.alarms` — never a bare `setTimeout`.
- The cap value stays single-sourced in `background.js`; only enforcement is duplicated.
- Worker suspension also threatened the *session state* itself (`recordingTabId`,
  `history` are in-memory): losing it mid-recording broke the stop/report handoff
  (timer froze at the cap, no finish dialog). Mitigation: the offscreen document — which
  stays alive for the whole recording — pings the worker (`KEEPALIVE`) every ~20s, so the
  worker never suspends *during* a recording. Enforcement-in-content (above) remains the
  primary trigger regardless.
