# CamSync Claude Code Guide

This file is the project memory for Claude Code. It is loaded automatically at
the start of a session and describes how CamSync is built, how to work on it
safely, and what to avoid. It replaces the previous `AGENTS.md`.

## Project Summary

CamSync is a mobile-first static web app for comparing a security camera's
displayed time against the device clock and recording the time drift.

The app is intended to run fully client-side, including on GitHub Pages, and
stores records in the browser's IndexedDB. It must not require a backend,
account system, cloud database, analytics service, or third-party runtime to
perform its core work.

The app may also include small standalone utility screens, such as a time
calculator. These utilities should stay separate from the main camera drift
recording flow unless the user explicitly asks to connect them.

## Product Intent

The app helps document the time offset of security camera footage. Important
fields include:

- reference time from the user's device clock
- camera-displayed time
- calculated drift
- camera location
- viewing date
- extraction date and time range
- witness information
- notes

The time calculator is intended as a separate field utility for ad hoc time
arithmetic, such as adding or subtracting a drift from a clock time or checking
a duration. It should be usable on its own and should not automatically create,
modify, or export drift records unless that behavior is explicitly requested.

Treat these records as potentially sensitive. Camera locations, witness names,
and notes may reveal private or operational information even though the app
itself is static and public.

## Working Rules

- Respond to the user in Japanese.
- Check existing files and patterns before editing.
- Keep the app dependency-free unless the user explicitly asks for a larger
  framework or build setup.
- Preserve the static GitHub Pages deployment model.
- Do not introduce server-side storage; records are intended to stay on the
  user's device.
- Do not add analytics, remote logging, external fonts, CDN scripts, or network
  calls without explicit user approval.
- Treat exported Markdown as a user-facing record format. Keep import/export
  compatibility when changing labels or fields.
- Preserve existing user data compatibility for IndexedDB records whenever
  practical.
- After changes, verify with a browser where practical. If only static checks
  are possible, report that clearly.

## Current Architecture

- Main app: `index.html`
- Service worker: `sw.js`
- Web app manifest: `manifest.json`
- Icon: `icons/icon.svg`
- UI: inline HTML and CSS
- Logic: inline vanilla JavaScript
- Persistence: IndexedDB database `CamSyncDB`, object store `records`
- Main screens: calculator, time calculator, history, info

## Local Development & Verification

There is no build step, package manager, or test runner. The app is a set of
static files opened directly in a browser.

- Preview locally by serving the directory over HTTP (needed so the service
  worker and IndexedDB behave like production), for example:
  - `python3 -m http.server 8000` then open `http://localhost:8000/`
- Service worker note: `sw.js` uses a versioned cache name (currently
  `camsync-v3`) and caches the app shell. When editing cached assets or the worker itself, bump `CACHE_NAME` so
  clients pick up the change, and hard-reload (or unregister the worker) while
  testing so you are not served a stale cache.
- If browser verification is not possible in the current environment, say so
  explicitly and describe what was only statically checked.

## Architecture Direction

Prefer keeping the app as a small static vanilla JavaScript app.

For the current size, a single `index.html` is acceptable because it keeps
deployment simple, avoids build tooling, and reduces dependency and
supply-chain risk. This is currently the more stable product shape as long as
the file remains easy to review and the security-sensitive flows are kept
simple.

Consider splitting files only when it clearly improves maintainability or
security. Good triggers include:

- JavaScript grows large enough that review of storage, import/export,
  rendering, and UI behavior becomes error-prone.
- A stronger Content Security Policy is being introduced and inline scripts /
  inline event handlers need to be removed.
- Tests or browser checks need reusable functions outside the page.
- CSS or JavaScript changes become frequent enough that a single file creates
  accidental regressions.

If splitting, prefer a minimal no-build structure:

- `index.html` for markup only
- `styles.css` for CSS
- `app.js` for UI orchestration
- `storage.js` for IndexedDB access
- `markdown.js` for import/export parsing and formatting
- `sw.js` for offline behavior

Do not introduce a framework just to split files.

## Security Guidance

CamSync's main security goal is to avoid exposing or corrupting local records
while keeping the public static code hard to abuse.

Pay special attention to:

- XSS: User-controlled values must be rendered with `textContent`, DOM node
  creation, or explicit HTML escaping (see the existing `escHtml` helper).
  Avoid inserting unsanitized values into `innerHTML`.
- Markdown import: Treat imported files as untrusted input. Validate required
  fields, keep file-size limits, and consider per-field length limits when
  changing this area.
- Markdown export: Keep exported output plain and predictable. Avoid embedding
  raw HTML or executable content.
- IndexedDB: Treat stored records as sensitive local data. Any new script
  running on the same origin can potentially read them.
- Service worker: Keep cache scope and cached request types narrow. Avoid
  caching arbitrary remote or unexpected same-origin responses.
- CSP readiness: Prefer `addEventListener` over inline `onclick` in new code.
  If the app is refactored, move toward a CSP that allows only same-origin
  scripts and no external network connections.
- Dependencies: Avoid third-party dependencies by default. If one becomes
  necessary, review its source, update path, license, and supply-chain risk.

## Review Checklist

Before finishing security-relevant changes, check:

- No secrets, tokens, or private URLs were added.
- No remote network call was added accidentally.
- User input displayed in history, edit screens, toasts, and exports is handled
  intentionally.
- Import/export remains compatible with existing CamSync Markdown records.
- IndexedDB schema changes preserve or migrate existing records.
- Offline behavior still works after service worker changes.
- Browser verification was performed where practical.

## Non-Goals

- No multi-user sync.
- No server-side record storage.
- No authentication layer unless the product direction changes.
- No analytics or telemetry by default.
- No build step unless there is a clear product or security reason.
