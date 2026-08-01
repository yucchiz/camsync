# Repository Guidelines

## Project Summary & Product Intent

CamSync is a dependency-free, mobile-first static PWA for comparing a security camera's displayed time with the device clock and recording the drift. It runs fully client-side, including on GitHub Pages, and stores records in browser IndexedDB. Core operation must not require a backend, account, cloud database, analytics service, or third-party runtime.

Records may contain camera locations, viewing and extraction dates, witness details, and notes. Treat them as sensitive operational data. The standalone time calculator is an independent field utility; do not connect it to saved drift records unless explicitly requested.

## Agent Working Rules

- Respond to the user in Japanese; follow the repository's existing language for code comments, commits, and documentation.
- Inspect existing files and patterns before editing, and make small, verifiable changes.
- Keep the app dependency-free and preserve static GitHub Pages deployment unless a larger architecture is explicitly approved.
- Do not add server storage, analytics, remote logging, external fonts, CDN scripts, or network calls without explicit approval.
- Preserve existing IndexedDB data and exported Markdown compatibility whenever practical.
- Verify changes in a browser where possible. If only static checks are possible, state that limitation.

## Project Structure & Module Organization

- `index.html`: markup, CSS, and inline vanilla JavaScript for all screens and application logic.
- `sw.js`: versioned app-shell caching and offline behavior.
- `manifest.json`: PWA installation metadata.
- `icons/icon.svg`: application icon.

There is no generated build output, package manager, or test directory. The IndexedDB database is `CamSyncDB`; its `records` store uses an auto-incrementing `id` key.

### Code Map

The inline script in `index.html` is divided by `// =====` section comments:

- IndexedDB: `openDB`, `addRecord`, `getAllRecords`, `getRecord`, `updateRecord`, `deleteRecord`, and `clearAllRecords`.
- Drift flow: `calculate`, `saveRecord`, and related time helpers.
- Time calculator: `calculateTimeOffset` and its helpers; keep this separate from record persistence.
- History: `renderHistory`, swipe handlers, and edit-modal functions.
- Markdown: `exportRecord`, `handleImportFile`, and `parseMdRecord`; imports are limited by `MAX_IMPORT_BYTES`.

## Markdown Record Compatibility

Export and import depend on exact Japanese labels such as `基準時刻`, `カメラ表示時刻`, `誤差`, `記録日時`, `カメラ設置場所`, `閲覧日`, `抽出日`, `立会人`, and `補足`. `exportRecord` writes `- **基準時刻:** 値`, and `parseMdRecord` matches that structure. When changing labels or formats, update both paths and continue accepting previously exported records.

## Build, Test, and Development Commands

Serve the repository over HTTP so IndexedDB and the service worker behave like production:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Useful static checks are:

```sh
node --check sw.js
python3 -m json.tool manifest.json >/dev/null
git diff --check
```

The service worker currently uses `camsync-v6`. After changing cached assets or `sw.js`, bump `CACHE_NAME`, then test with a hard reload or freshly registered service worker to avoid stale files.

## Coding Style & Naming Conventions

Use two-space indentation and existing section-comment patterns. Use `camelCase` for JavaScript functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case for CSS classes. Prefer short, single-purpose functions and browser-native APIs. Avoid abstractions that require explanation.

Render user-controlled values with `textContent`, DOM creation, or `escHtml`; never insert unescaped stored or imported data into `innerHTML`. Prefer `addEventListener` for new interactions so the app can move toward a same-origin Content Security Policy.

## Testing Guidelines

No automated framework or coverage threshold exists. Every change requires an appropriate browser smoke test at mobile width. Depending on scope, verify:

- drift calculation and day-boundary behavior;
- save, edit, delete, and IndexedDB persistence;
- old and current Markdown export/import round-trips;
- offline loading and cache updates;
- time-calculator independence.

If reusable logic is extracted, use Node's built-in test runner and name files `*.test.js`. Never disable a failing test to ship a change.

## Architecture Direction

Prefer the current small, no-build vanilla JavaScript architecture. A single `index.html` is acceptable while it remains reviewable and security-sensitive flows stay simple. Split files only when it materially improves testing, maintainability, or CSP support. A suitable no-build split is `index.html`, `styles.css`, `app.js`, `storage.js`, `markdown.js`, and `sw.js`; do not introduce a framework merely to separate files.

## Commit & Pull Request Guidelines

Use the repository's Conventional Commit pattern with concise Japanese subjects, for example `feat: 抽出期間の日跨ぎ指定に対応`, `fix: ...`, `docs: ...`, or `chore: ...`. Keep commits focused and explain why the change is needed.

Pull requests should describe user-visible behavior, compatibility impact, and verification performed. Include mobile screenshots for UI changes. Explicitly note IndexedDB migrations, Markdown-format changes, service-worker cache changes, and any remaining manual verification.

## Security & Data Compatibility

- Treat Markdown imports as untrusted: validate required fields, file size, value formats, and reasonable field lengths.
- Keep Markdown exports plain and predictable; do not embed executable HTML.
- Preserve or migrate existing IndexedDB records when schemas change.
- Keep service-worker scope and cached request types narrow.
- Do not hard-code secrets, tokens, credentials, or private URLs.
- Review any proposed dependency for necessity, maintenance, license, security, and supply-chain risk.

## Review Checklist

Before completing a security- or data-sensitive change, confirm that no private data or remote call was introduced, all user-controlled rendering is intentional, old records still load, Markdown remains backward compatible, offline behavior still works, and relevant browser verification was performed.

## Non-Goals

Multi-user sync, server-side storage, authentication, analytics, telemetry, and a build step are out of scope unless the product direction explicitly changes.
