# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Echooo** — Chrome extension (MV3, vanilla JS) that logs tab activity + Next.js backend that asks Claude to identify repeated workflows in the log and generate SOPs + paste-ready Claude prompts. Built solo at the Push to Prod Hackathon, 24 April 2026. Full spec: `/Users/jordonho/Downloads/ECHOOO_BUILD_BRIEF.md`.

Two independent codebases under one repo:
- `extension/` — no build step, loaded unpacked in Chrome
- `web/` — Next.js 15 App Router, TypeScript, one API route

## Commands

All backend commands run from `web/`:

| Task | Command |
|---|---|
| Install deps | `npm install` |
| Local dev server | `npm run dev` (http://localhost:3000) |
| Type check | `npx tsc --noEmit` |
| Production build | `npm run build` (or `npx next build`) |
| Deploy to Vercel | `vercel --prod` |
| List / add env vars | `vercel env ls`, `vercel env add ANTHROPIC_API_KEY production` |
| Inspect failed deploy | `vercel inspect <deployment-url> --logs` |
| Test endpoint against fixture | `curl -X POST <url>/api/analyze -H "Content-Type: application/json" -d "{\"session_log\": $(cat ../extension/fixtures/demo-session.json)}"` |

There are no tests or linters configured — this is a hackathon build.

## Architecture

### The data flow that spans files

A session travels through **4 locations** — understanding the handoffs matters more than any single file:

```
chrome.tabs events
  → background.js (filters by is_recording flag)
  → chrome.storage.local (session_log array)
  → app.js reads + POSTs to backend
  → web/app/api/analyze/route.ts compresses + calls Claude
  → response parsed, stored back in chrome.storage.local (analysis_result)
  → app.js renders workflow cards (live via storage.onChanged)
```

**Storage keys in `chrome.storage.local`** (all read/written by both `background.js` and `app.js`):
- `is_recording` — boolean, gates background.js event logging
- `session_log` — array of `SessionEvent`
- `analysis_result` — Claude's parsed JSON response
- `view_state` — `idle` / `recording` / `analyzing` / `results` / `error`
- `last_error` — error message for the error view

The app tab re-reads storage on load and reacts to `chrome.storage.onChanged` so state stays live even if the background worker writes while the tab is in the foreground. The state machine is in `app.js` (`route()` function).

### The extension UI is a full tab, not a popup

The toolbar action has no `default_popup`. Clicking the icon fires `chrome.action.onClicked` in `background.js`, which opens (or focuses) a single `chrome-extension://<id>/app.html` tab. The tab is meant to be pinned — recording runs in the background service worker regardless of whether the tab is visible. A `REC` badge on the toolbar icon reflects `is_recording` so the user knows a session is active even without opening the tab.

### Server-side event compression is load-bearing

`web/app/api/analyze/route.ts` compresses raw events → `Visit[]` *before* sending to Claude. Two rules (from brief §7):
1. Consecutive events on the same domain within 60s collapse into one visit.
2. Visits shorter than 5s are dropped (tab thrash noise).

Change these thresholds carefully — the demo fixture (`extension/fixtures/demo-session.json`) is hand-timed to land cleanly under both rules. Loosening them floods Claude with noise; tightening drops real events.

### The JSON schema contract

`web/lib/prompts.ts` defines `ANALYSIS_SCHEMA` (what Claude must return) and `app.js` renders fields from that schema directly. The two files must stay in sync:
- Workflow cards read `name`, `occurrences`, `avg_duration_min`, `steps[]`, `ai_leverage[]`, `inferred_rules[]`, `ready_prompt`.
- `ai_leverage[].verdict` must be one of `automatable` / `deterministic` / `judgment` — CSS classes `.verdict-automatable` etc. in `app.css` are keyed to these strings.

The backend does not use `output_config.format` (SDK 0.30.1 predates it). Instead, the system prompt instructs strict JSON and the route strips markdown fences defensively before `JSON.parse`.

### CORS + the extension origin

Extensions have origin `chrome-extension://<id>/` — the backend sets `Access-Control-Allow-Origin: *` on every response (success and error paths) and exports an `OPTIONS` handler. If you add a new response path in `route.ts`, it MUST include `CORS_HEADERS`, or the extension will see a CORS failure in place of the real error.

### The `BACKEND_URL` constant

Top of `extension/app.js`. After each Vercel deploy, this must be updated to the production URL. During local dev, leave it at `http://localhost:3000/api/analyze` and run `npm run dev`.

### Vercel framework detection

`web/vercel.json` declares `{"framework": "nextjs"}` — without it, Vercel auto-detection failed during this build (fell through to static-site mode and errored with "No Output Directory named 'public' found" *after* a successful `next build`). Don't delete this file.

## Scope guardrails (from the brief)

These are explicitly **out** — don't add them:
- Auth / user accounts
- Any database or persistence beyond `chrome.storage.local`
- Team features, sharing, dashboards
- Writing back to Notion / Slack / Confluence
- Real-time pattern detection (analysis is on-demand only)
- Content scripts reading page DOM (tab metadata only, for privacy)
- Vector DB / embeddings / custom clustering

If asked to add any of the above mid-session: flag it as out-of-scope per the brief before implementing.

**Fallback cut order** if behind schedule: markdown export → inferred rules → noise filtering. **Never cut the "Copy Claude prompt" button** — that's the demo climax.

## Model choice — do not swap

Use `claude-sonnet-4-6` (set in `web/app/api/analyze/route.ts`). The brief explicitly says NOT Opus — Sonnet is picked for demo speed. Don't migrate to Opus 4.7 / 4.6 during the hackathon window.

## Demo safety net

`extension/fixtures/demo-session.json` is the authoritative demo input. The "Load demo fixture" button on the idle screen loads it into `session_log` and transitions straight to analyzing. **Record the demo video against the fixture, never live capture** (brief §15) — fixture output is deterministic-ish; live tab events are not.
