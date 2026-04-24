# Echooo

**Your AI-adoption buddy.** A Chrome extension that watches how you actually work across browser tabs, detects your repeated workflows, and hands back (a) an auto-written SOP and (b) a ready-to-paste Claude prompt — so non-technical teammates can delegate to AI without learning prompt engineering.

Built solo in ~5 hours at the **Push to Prod Hackathon** (Anthropic × Genspark × Temasek) on 24 April 2026.

## The problem

- Non-technical workers can't verbalize their workflows well enough to prompt an LLM — so AI adoption stalls even when the AI itself is capable.
- SOPs are always out of date. Nobody has time to write them.
- AI transformation teams have no measurement layer for whether workflows are actually shifting to AI-assisted.

## The insight

The context an LLM needs is already in *what people do*. Watch the work, and both the documentation and the prompt write themselves.

## What it does

1. The Chrome extension logs your tab activity during a work session (domain, title, URL, timestamp — no DOM, no page contents).
2. On **Stop & Analyze**, the session log is POSTed to a tiny Next.js backend that asks Claude Sonnet 4.6 to identify repeated workflows.
3. For each detected workflow, you get:
   - An auto-generated **SOP** (the step list).
   - An **AI leverage analysis** — per step, is it automatable / deterministic / judgment?
   - Any **inferred rules** Claude spotted across the examples.
   - A **ready-to-paste Claude prompt** — rich with context, so a teammate can drop it into claude.ai and get useful output on the first try.
4. One-click **Download all SOPs as markdown** for your wiki.

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  Chrome Extension (MV3) │         │  Next.js on Vercel       │
│                         │  HTTPS  │                          │
│  background.js          │────────▶│  POST /api/analyze       │
│    tab event logger     │   JSON  │    │                     │
│                         │         │    ▼                     │
│  popup.html/js          │         │  Anthropic SDK           │
│    Start / Stop toggle  │         │  claude-sonnet-4-6       │
│  app.html/js            │         │                          │
│    full-tab SOP view    │         │                          │
│                         │◀────────│    │                     │
│  chrome.storage.local   │   JSON  │    ▼                     │
│    session log          │         │  Structured JSON reply   │
└─────────────────────────┘         └──────────────────────────┘
```

- Extension can't call Anthropic directly (API key leak + CORS) — backend hides the key.
- No database. Sessions live in `chrome.storage.local`; analysis is on-demand.
- Session events are compressed server-side before Claude sees them (collapse same-domain within 60s, drop < 5s visits).

## Install & run

You'll need: an Anthropic API key (console.anthropic.com), a Vercel account, Node 18+.

### Backend

```bash
cd web
npm install
vercel link           # first time — creates .vercel/
vercel env add ANTHROPIC_API_KEY production
vercel --prod
```

Copy the deployed URL (e.g. `https://echooo-xyz.vercel.app`).

### Extension

1. Open `extension/background.js` and set `BACKEND_URL` to `https://<your-vercel-url>/api/analyze` (top of the file).
2. Open Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder.
3. Click the Echooo toolbar icon — a small popup opens with **Start session** / **Stop & Analyze**. A `REC` badge on the toolbar icon confirms a session is active. Hit **Open Echooo tab →** any time to see the full SOP view (workflow cards + Copy-prompt buttons + markdown export).

**For a reliable demo without live capture:** click **Load demo fixture** on the idle screen — it loads a hand-crafted session log showing refund processing, customer onboarding, and standup prep workflows.

## Repository layout

```
echooo/
├── extension/               # Chrome extension (MV3, vanilla JS)
│   ├── manifest.json
│   ├── background.js        # tab event listener → chrome.storage.local
│   ├── popup.{html,css,js}  # compact Start / Stop toggle
│   ├── app.{html,css,js}    # full-tab SOP view: idle / recording / analyzing / results / error
│   ├── icons/
│   └── fixtures/demo-session.json
├── web/                     # Next.js backend (single API route)
│   ├── app/api/analyze/route.ts
│   ├── lib/prompts.ts
│   └── package.json
└── README.md
```

## What's next (not in this build)

- **Team aggregation.** Opt-in workflow fingerprints roll up to a dashboard: which manual workflows have shifted to AI-assisted over time? Leadership gets a real AI-transformation signal.
- **Auto-ticketing.** Workflows too gnarly for individual adoption get flagged to the AI transformation team with the session evidence attached.
- **Native capture.** Extend beyond the browser — watch desktop app switching and file interactions, not just tabs.

## Credits

Built by Jordon at Push to Prod Hackathon, 24 April 2026. All code in this repo was written on-site during the 5-hour window. Ideas and prompts were sketched beforehand in a build brief; no code was pre-written.
