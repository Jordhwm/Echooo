// Echooo app page — full-tab UI driven by chrome.storage.local state.
// The analyze fetch lives in background.js (single source of truth).

const STORAGE_KEYS = {
  IS_RECORDING: "is_recording",
  SESSION_LOG: "session_log",
  ANALYSIS: "analysis_result",
  VIEW: "view_state",
  ERROR: "last_error",
  WIKI: "wiki_sops",
};

const VIEWS = {
  IDLE: "idle",
  RECORDING: "recording",
  ANALYZING: "analyzing",
  RESULTS: "results",
  ERROR: "error",
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Tab state lives in JS — resets on reload. Dismiss decisions are ephemeral
// too (brief: clear on popup close → clear on tab reload for the app).
let currentTab = "analyze";
const dismissedIds = new Set(); // keys for "new" workflow cards (by name)
const expandedCards = new Set(); // card ids currently showing full SOP detail

function showView(name) {
  $$("main#app .view").forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
  renderHeader(name);
  renderTabNav(name);
}

function renderHeader(view) {
  const showStatus = view === VIEWS.RECORDING;
  const showStart = view === VIEWS.IDLE;
  const showStop = view === VIEWS.RECORDING;
  const showReset = view === VIEWS.RESULTS || view === VIEWS.ERROR;

  $("#header-status").hidden = !showStatus;
  $("#header-status").textContent = showStatus ? "● Recording" : "";
  $("#start-btn").hidden = !showStart;
  $("#stop-btn").hidden = !showStop;
  $("#reset-btn").hidden = !showReset;
}

async function renderTabNav(view) {
  const nav = $("#tab-nav");
  // Show tabs whenever the user has results OR a saved wiki.
  const { [STORAGE_KEYS.WIKI]: wiki = [] } = await chrome.storage.local.get(STORAGE_KEYS.WIKI);
  const shouldShow = view === VIEWS.RESULTS || (wiki.length > 0 && view !== VIEWS.IDLE);
  nav.hidden = !shouldShow;
  if (!shouldShow) return;

  $$(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentTab);
  });

  // Update the wiki tab's "N suggested updates" count
  const count = await getSuggestedUpdateCount();
  const countEl = $("#wiki-tab-count");
  if (count > 0) {
    countEl.textContent = String(count);
    countEl.hidden = false;
  } else {
    countEl.hidden = true;
  }
}

async function getSuggestedUpdateCount() {
  const { [STORAGE_KEYS.ANALYSIS]: analysis } = await chrome.storage.local.get(STORAGE_KEYS.ANALYSIS);
  if (!analysis?.workflows) return 0;
  return analysis.workflows.filter((w) => w.status === "updated").length;
}

async function showTab(tab) {
  currentTab = tab;
  $$(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  // Only toggle views when we're in a state that has tabs (results).
  const state = await getState();
  const baseView = state[STORAGE_KEYS.VIEW];
  if (baseView !== VIEWS.RESULTS && baseView !== VIEWS.IDLE) return;

  if (tab === "wiki") {
    $$("main#app .view").forEach((el) => {
      el.hidden = el.dataset.view !== "wiki";
    });
    await renderWiki();
  } else {
    // Analyze tab = whatever the baseView says (typically results).
    showView(baseView === VIEWS.IDLE ? VIEWS.IDLE : VIEWS.RESULTS);
    if (baseView === VIEWS.RESULTS) await renderResults();
  }
}

async function getState() {
  return chrome.storage.local.get([
    STORAGE_KEYS.IS_RECORDING,
    STORAGE_KEYS.SESSION_LOG,
    STORAGE_KEYS.ANALYSIS,
    STORAGE_KEYS.VIEW,
    STORAGE_KEYS.ERROR,
  ]);
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// --- View renderers ---

async function renderRecording() {
  const { [STORAGE_KEYS.SESSION_LOG]: log = [] } = await chrome.storage.local.get(
    STORAGE_KEYS.SESSION_LOG,
  );
  $("#visit-count").textContent = String(log.length);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function renderWorkflowCard(workflow, index) {
  const steps = (workflow.steps || [])
    .map((step, i) => `
      <li class="step-item">
        <span class="step-num">${i + 1}</span>
        <div>
          <span class="step-domain">${escapeHtml(step.domain || "")}</span>
          <span class="step-action"> — ${escapeHtml(step.action || "")}</span>
        </div>
      </li>`)
    .join("");

  const leverage = (workflow.ai_leverage || [])
    .map((lev) => {
      const cls = `verdict-${lev.verdict || "judgment"}`;
      return `
        <div class="verdict-item">
          <span class="verdict-tag ${cls}">${escapeHtml(lev.verdict || "?")}</span>
          <span class="verdict-why">Step ${(lev.step_index ?? 0) + 1}: ${escapeHtml(lev.why || "")}</span>
        </div>`;
    })
    .join("");

  const rules = (workflow.inferred_rules || []).filter(Boolean);
  const rulesHtml = rules.length
    ? `
      <div class="rules-callout">
        <strong>Inferred rules</strong>
        <ul>${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      </div>`
    : "";

  const occurrences = workflow.occurrences ?? 0;
  const avg = workflow.avg_duration_min;
  const meta = avg != null ? `${avg} min average` : "";

  return `
    <article class="workflow-card" data-workflow-index="${index}">
      <div class="workflow-head">
        <div class="workflow-name">${escapeHtml(workflow.name || "Untitled workflow")}</div>
        <span class="workflow-badge">Detected ${occurrences}×</span>
      </div>
      ${meta ? `<div class="workflow-meta">${escapeHtml(meta)}</div>` : ""}

      <div class="card-col">
        <div class="section-label">SOP</div>
        <ol class="step-list">${steps}</ol>
      </div>

      <div class="card-col">
        <div class="section-label">AI leverage</div>
        <div class="verdict-list">${leverage || '<span class="verdict-why">—</span>'}</div>
      </div>

      ${rulesHtml}

      <button class="copy-prompt-btn" data-prompt-index="${index}">
        📋 Copy Claude prompt
      </button>
    </article>`;
}

async function renderResults() {
  const { [STORAGE_KEYS.ANALYSIS]: result } = await chrome.storage.local.get(STORAGE_KEYS.ANALYSIS);
  if (!result) return;

  $("#summary").textContent = result.summary || "";
  const workflows = Array.isArray(result.workflows) ? result.workflows : [];
  $("#workflows").innerHTML = workflows.map((w, i) => renderWorkflowCard(w, i)).join("");

  $$(".copy-prompt-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.promptIndex);
      const prompt = workflows[idx]?.ready_prompt || "";
      try {
        await navigator.clipboard.writeText(prompt);
        btn.classList.add("copied");
        const original = btn.textContent;
        btn.textContent = "✓ Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.textContent = original;
        }, 1600);
      } catch (err) {
        btn.textContent = "Copy failed — see console";
        console.error(err);
      }
    });
  });
}

async function renderError() {
  const { [STORAGE_KEYS.ERROR]: message } = await chrome.storage.local.get(STORAGE_KEYS.ERROR);
  const text = (typeof message === "string" && message.trim())
    ? message
    : "No error details were recorded. This is usually stale state — click “Try again” to reset.";
  $("#error-message").textContent = text;
  console.warn("[Echooo] error view rendered:", { storedMessage: message });
}

// --- Wiki rendering ---

function renderWikiCardInner(steps, aiLeverage, rules) {
  const stepsHtml = (steps || [])
    .map((step, i) => `
      <li class="step-item">
        <span class="step-num">${i + 1}</span>
        <div>
          <span class="step-domain">${escapeHtml(step.domain || "")}</span>
          <span class="step-action"> — ${escapeHtml(step.action || "")}</span>
        </div>
      </li>`)
    .join("");

  const leverageHtml = (aiLeverage || [])
    .map((lev) => {
      const cls = `verdict-${lev.verdict || "judgment"}`;
      return `
        <div class="verdict-item">
          <span class="verdict-tag ${cls}">${escapeHtml(lev.verdict || "?")}</span>
          <span class="verdict-why">Step ${(lev.step_index ?? 0) + 1}: ${escapeHtml(lev.why || "")}</span>
        </div>`;
    })
    .join("");

  const rulesList = (rules || []).filter(Boolean);
  const rulesHtml = rulesList.length
    ? `<div class="rules-callout">
         <strong>Inferred rules</strong>
         <ul>${rulesList.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
       </div>`
    : "";

  return `
    <div class="section-label">SOP</div>
    <ol class="step-list">${stepsHtml}</ol>
    ${leverageHtml ? `<div class="section-label">AI leverage</div><div class="verdict-list">${leverageHtml}</div>` : ""}
    ${rulesHtml}`;
}

function renderWikiCard(entry) {
  if (entry.kind === "saved") {
    const { sop, status, diff_summary, proposed } = entry;
    const label =
      status === "updated" ? "Suggested update"
      : status === "unchanged" ? "Up to date"
      : "Up to date";
    const diffHtml = diff_summary && diff_summary.length
      ? `<ul class="diff-bullets">${diff_summary.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
      : "";
    const actions = status === "updated"
      ? `<button class="btn btn-accept" data-action="accept" data-sop-id="${sop.id}">Accept update</button>
         <button class="btn btn-ghost" data-action="view" data-sop-id="${sop.id}">View full SOP</button>
         <button class="btn btn-ghost" data-action="dismiss" data-dismiss-key="${sop.id}">Dismiss</button>`
      : `<button class="btn btn-ghost" data-action="view" data-sop-id="${sop.id}">View full SOP</button>`;

    const detailSource = status === "updated" && proposed ? proposed : sop;
    const isExpanded = expandedCards.has(sop.id);

    return `
      <article class="wiki-card status-${status} ${isExpanded ? "expanded" : ""}" data-sop-id="${sop.id}">
        <div class="wiki-head">
          <span class="status-dot"></span>
          <span class="wiki-name">${escapeHtml(sop.name || "Untitled SOP")}</span>
          <span class="wiki-status-label">${label}</span>
        </div>
        ${diffHtml}
        <div class="wiki-actions">${actions}</div>
        <div class="wiki-detail">
          ${renderWikiCardInner(detailSource.steps, detailSource.ai_leverage, detailSource.inferred_rules)}
          ${sop.ready_prompt ? `<button class="copy-prompt-btn" data-copy-prompt="${encodeURIComponent(sop.ready_prompt)}">📋 Copy Claude prompt</button>` : ""}
        </div>
      </article>`;
  }

  // kind === "new"
  const wf = entry.workflow;
  const dismissKey = `new:${wf.name}`;
  const isExpanded = expandedCards.has(dismissKey);
  return `
    <article class="wiki-card status-new ${isExpanded ? "expanded" : ""}" data-new-key="${escapeHtml(dismissKey)}">
      <div class="wiki-head">
        <span class="status-dot"></span>
        <span class="wiki-name">${escapeHtml(wf.name || "Untitled workflow")}</span>
        <span class="wiki-status-label">New</span>
      </div>
      <div class="wiki-meta">Detected this session · not saved · ${wf.occurrences ?? 0}× occurrences</div>
      <div class="wiki-actions">
        <button class="btn btn-save" data-action="save" data-new-key="${escapeHtml(dismissKey)}">Save to wiki</button>
        <button class="btn btn-ghost" data-action="view" data-new-key="${escapeHtml(dismissKey)}">View full SOP</button>
        <button class="btn btn-ghost" data-action="dismiss" data-dismiss-key="${escapeHtml(dismissKey)}">Dismiss</button>
      </div>
      <div class="wiki-detail">
        ${renderWikiCardInner(wf.steps, wf.ai_leverage, wf.inferred_rules)}
        ${wf.ready_prompt ? `<button class="copy-prompt-btn" data-copy-prompt="${encodeURIComponent(wf.ready_prompt)}">📋 Copy Claude prompt</button>` : ""}
      </div>
    </article>`;
}

async function renderWiki() {
  const { [STORAGE_KEYS.WIKI]: wiki = [], [STORAGE_KEYS.ANALYSIS]: analysis } =
    await chrome.storage.local.get([STORAGE_KEYS.WIKI, STORAGE_KEYS.ANALYSIS]);
  const workflows = Array.isArray(analysis?.workflows) ? analysis.workflows : [];

  const byMatchedId = new Map(
    workflows
      .filter((w) => w.matched_sop_id)
      .map((w) => [w.matched_sop_id, w]),
  );

  const savedWithStatus = wiki.map((sop) => {
    const detection = byMatchedId.get(sop.id);
    return {
      kind: "saved",
      sop,
      status: detection?.status ?? "unchanged",
      diff_summary: detection?.diff_summary ?? null,
      proposed: detection?.status === "updated" ? detection : null,
    };
  });

  const newlyDetected = workflows
    .filter((w) => w.status === "new" && !dismissedIds.has(`new:${w.name}`))
    .map((w) => ({ kind: "new", workflow: w }));

  // Order: updated first, then new, then unchanged
  const ordered = [
    ...savedWithStatus.filter((x) => x.status === "updated"),
    ...newlyDetected,
    ...savedWithStatus.filter((x) => x.status === "unchanged"),
  ];

  const summaryEl = $("#wiki-summary");
  const suggestedCount = savedWithStatus.filter((x) => x.status === "updated").length;
  summaryEl.textContent = wiki.length === 0 && newlyDetected.length === 0
    ? ""
    : `${wiki.length} saved SOP${wiki.length === 1 ? "" : "s"}${
        suggestedCount > 0 ? ` · ${suggestedCount} suggested update${suggestedCount === 1 ? "" : "s"}` : ""
      }${newlyDetected.length > 0 ? ` · ${newlyDetected.length} new detected` : ""}`;

  const container = $("#wiki-cards");
  if (ordered.length === 0) {
    container.innerHTML = `
      <div class="wiki-empty">
        Your wiki is empty. Run Analyze and save detected workflows here to start building your living documentation.
      </div>`;
    return;
  }

  container.innerHTML = ordered.map(renderWikiCard).join("");
  attachWikiHandlers(savedWithStatus, newlyDetected);
}

function attachWikiHandlers(savedWithStatus, newlyDetected) {
  $$("#wiki-cards button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "save") {
        await handleSave(btn.dataset.newKey, newlyDetected);
      } else if (action === "accept") {
        await handleAccept(btn.dataset.sopId, savedWithStatus);
      } else if (action === "dismiss") {
        dismissedIds.add(btn.dataset.dismissKey);
        await renderWiki();
      } else if (action === "view") {
        const key = btn.dataset.sopId || btn.dataset.newKey;
        if (expandedCards.has(key)) expandedCards.delete(key);
        else expandedCards.add(key);
        await renderWiki();
      }
    });
  });

  $$("#wiki-cards .copy-prompt-btn[data-copy-prompt]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const prompt = decodeURIComponent(btn.dataset.copyPrompt || "");
      try {
        await navigator.clipboard.writeText(prompt);
        btn.classList.add("copied");
        const original = btn.textContent;
        btn.textContent = "✓ Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.textContent = original;
        }, 1600);
      } catch (err) {
        console.error(err);
      }
    });
  });
}

async function handleSave(dismissKey, newlyDetected) {
  const entry = newlyDetected.find((x) => `new:${x.workflow.name}` === dismissKey);
  if (!entry) return;
  const wf = entry.workflow;
  const sop = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `sop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: wf.name,
    steps: wf.steps || [],
    ai_leverage: wf.ai_leverage || [],
    inferred_rules: wf.inferred_rules || [],
    ready_prompt: wf.ready_prompt || "",
    saved_at: Date.now(),
    last_verified_at: Date.now(),
  };
  const { [STORAGE_KEYS.WIKI]: wiki = [] } = await chrome.storage.local.get(STORAGE_KEYS.WIKI);
  wiki.push(sop);
  await chrome.storage.local.set({ [STORAGE_KEYS.WIKI]: wiki });
  dismissedIds.add(dismissKey); // prevent the same card from rendering again until re-detected
  await renderWiki();
}

async function handleAccept(sopId, savedWithStatus) {
  const entry = savedWithStatus.find((x) => x.sop.id === sopId);
  if (!entry?.proposed) return;
  const { [STORAGE_KEYS.WIKI]: wiki = [] } = await chrome.storage.local.get(STORAGE_KEYS.WIKI);
  const idx = wiki.findIndex((s) => s.id === sopId);
  if (idx === -1) return;
  const proposed = entry.proposed;
  wiki[idx] = {
    ...wiki[idx],
    name: proposed.name || wiki[idx].name,
    steps: proposed.steps || wiki[idx].steps,
    ai_leverage: proposed.ai_leverage || wiki[idx].ai_leverage,
    inferred_rules: proposed.inferred_rules || wiki[idx].inferred_rules,
    ready_prompt: proposed.ready_prompt || wiki[idx].ready_prompt,
    last_verified_at: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.WIKI]: wiki });
  // Clear the "updated" status on this detection so it doesn't re-flash
  // on the next render — we do that by mutating the cached analysis_result.
  const { [STORAGE_KEYS.ANALYSIS]: analysis } = await chrome.storage.local.get(STORAGE_KEYS.ANALYSIS);
  if (analysis?.workflows) {
    analysis.workflows = analysis.workflows.map((w) =>
      w.matched_sop_id === sopId
        ? { ...w, status: "unchanged", diff_summary: null }
        : w,
    );
    await chrome.storage.local.set({ [STORAGE_KEYS.ANALYSIS]: analysis });
  }
  await renderWiki();
}

// --- Actions ---

async function startSession() {
  await setState({
    [STORAGE_KEYS.IS_RECORDING]: true,
    [STORAGE_KEYS.SESSION_LOG]: [],
    [STORAGE_KEYS.ANALYSIS]: null,
    [STORAGE_KEYS.ERROR]: null,
    [STORAGE_KEYS.VIEW]: VIEWS.RECORDING,
  });
  // NOTE: wiki_sops is intentionally NOT cleared — it persists across sessions.
  await route();
}

async function stopAndAnalyze() {
  // Delegate the fetch to the background service worker so it isn't bound
  // to this tab's lifecycle. UI state updates will come back via
  // chrome.storage.onChanged → route().
  await chrome.runtime.sendMessage({ cmd: "stop-and-analyze" });
}

async function resetToIdle() {
  await setState({
    [STORAGE_KEYS.IS_RECORDING]: false,
    [STORAGE_KEYS.SESSION_LOG]: [],
    [STORAGE_KEYS.ANALYSIS]: null,
    [STORAGE_KEYS.ERROR]: null,
    [STORAGE_KEYS.VIEW]: VIEWS.IDLE,
  });
  // wiki_sops preserved intentionally.
  await route();
}

async function loadFixture() {
  try {
    const res = await fetch(chrome.runtime.getURL("fixtures/demo-session.json"));
    if (!res.ok) throw new Error(`Fixture HTTP ${res.status}`);
    const fixture = await res.json();
    await setState({
      [STORAGE_KEYS.IS_RECORDING]: false,
      [STORAGE_KEYS.SESSION_LOG]: fixture,
      [STORAGE_KEYS.ANALYSIS]: null,
      [STORAGE_KEYS.ERROR]: null,
    });
    await chrome.runtime.sendMessage({ cmd: "stop-and-analyze" });
  } catch (err) {
    console.error("Fixture load failed:", err);
    await setState({
      [STORAGE_KEYS.ERROR]: `Could not load fixture: ${err.message}`,
      [STORAGE_KEYS.VIEW]: VIEWS.ERROR,
    });
    await route();
  }
}

// Demo shortcut (?demo): session 1 → save all → session 2 → analyze → Wiki tab.
async function loadDemoWikiFlow() {
  try {
    console.info("[Echooo demo] stage 1/3: analyzing session 1");
    const res1 = await fetch(chrome.runtime.getURL("fixtures/demo-session.json"));
    const fx1 = await res1.json();
    await chrome.storage.local.set({
      [STORAGE_KEYS.WIKI]: [], // start clean for a deterministic demo
      [STORAGE_KEYS.SESSION_LOG]: fx1,
      [STORAGE_KEYS.ANALYSIS]: null,
      [STORAGE_KEYS.ERROR]: null,
      [STORAGE_KEYS.VIEW]: VIEWS.ANALYZING,
    });
    await chrome.runtime.sendMessage({ cmd: "stop-and-analyze" });

    // Wait for analysis to land
    const analysis1 = await waitForAnalysis();
    if (!analysis1?.workflows?.length) throw new Error("Session 1 analysis returned no workflows");

    // Save all detected workflows to the wiki
    console.info(`[Echooo demo] stage 2/3: saving ${analysis1.workflows.length} workflows to wiki`);
    const wiki = analysis1.workflows.map((w) => ({
      id: (crypto.randomUUID && crypto.randomUUID()) || `sop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: w.name,
      steps: w.steps || [],
      ai_leverage: w.ai_leverage || [],
      inferred_rules: w.inferred_rules || [],
      ready_prompt: w.ready_prompt || "",
      saved_at: Date.now(),
      last_verified_at: Date.now(),
    }));
    await chrome.storage.local.set({ [STORAGE_KEYS.WIKI]: wiki });

    // Load session 2 and trigger analysis against the saved wiki
    console.info("[Echooo demo] stage 3/3: analyzing session 2 against saved wiki");
    const res2 = await fetch(chrome.runtime.getURL("fixtures/demo-session-2.json"));
    const fx2 = await res2.json();
    await chrome.storage.local.set({
      [STORAGE_KEYS.SESSION_LOG]: fx2,
      [STORAGE_KEYS.ANALYSIS]: null,
      [STORAGE_KEYS.VIEW]: VIEWS.ANALYZING,
    });
    await chrome.runtime.sendMessage({ cmd: "stop-and-analyze" });
    await waitForAnalysis();

    // Switch to Wiki tab
    await showTab("wiki");
  } catch (err) {
    console.error("[Echooo demo] failed:", err);
    await chrome.storage.local.set({
      [STORAGE_KEYS.ERROR]: `Demo wiki flow failed: ${err.message}`,
      [STORAGE_KEYS.VIEW]: VIEWS.ERROR,
    });
    await route();
  }
}

function waitForAnalysis(timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.storage.onChanged.removeListener(onChange);
      reject(new Error("Analyze timed out"));
    }, timeoutMs);
    function onChange(changes) {
      if (changes[STORAGE_KEYS.VIEW]) {
        const v = changes[STORAGE_KEYS.VIEW].newValue;
        if (v === VIEWS.RESULTS) {
          clearTimeout(timer);
          chrome.storage.onChanged.removeListener(onChange);
          chrome.storage.local.get(STORAGE_KEYS.ANALYSIS).then(({ [STORAGE_KEYS.ANALYSIS]: a }) => resolve(a));
        } else if (v === VIEWS.ERROR) {
          clearTimeout(timer);
          chrome.storage.onChanged.removeListener(onChange);
          chrome.storage.local.get(STORAGE_KEYS.ERROR).then(({ [STORAGE_KEYS.ERROR]: e }) =>
            reject(new Error(e || "Analyze failed")),
          );
        }
      }
    }
    chrome.storage.onChanged.addListener(onChange);
  });
}

async function downloadMarkdown() {
  const { [STORAGE_KEYS.ANALYSIS]: result } = await chrome.storage.local.get(STORAGE_KEYS.ANALYSIS);
  if (!result) return;

  const lines = [];
  lines.push(`# Echooo — Detected Workflows\n`);
  if (result.summary) lines.push(`> ${result.summary}\n`);

  for (const wf of result.workflows || []) {
    lines.push(`\n## ${wf.name || "Untitled workflow"}`);
    if (wf.occurrences != null) lines.push(`**Detected:** ${wf.occurrences}×`);
    if (wf.avg_duration_min != null) lines.push(`**Avg duration:** ${wf.avg_duration_min} min`);

    lines.push(`\n### Steps`);
    (wf.steps || []).forEach((s, i) => {
      lines.push(`${i + 1}. **${s.domain || ""}** — ${s.action || ""}`);
    });

    if ((wf.ai_leverage || []).length) {
      lines.push(`\n### AI leverage`);
      for (const lev of wf.ai_leverage) {
        lines.push(`- Step ${(lev.step_index ?? 0) + 1} (**${lev.verdict || "?"}**): ${lev.why || ""}`);
      }
    }

    if ((wf.inferred_rules || []).length) {
      lines.push(`\n### Inferred rules`);
      for (const r of wf.inferred_rules) lines.push(`- ${r}`);
    }

    if (wf.ready_prompt) {
      lines.push(`\n### Ready Claude prompt\n`);
      lines.push("```");
      lines.push(wf.ready_prompt);
      lines.push("```");
    }
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `echooo-sops-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Routing ---

async function route() {
  const state = await getState();
  let view = state[STORAGE_KEYS.VIEW] || VIEWS.IDLE;

  // Self-heal if stored view disagrees with flags.
  if (state[STORAGE_KEYS.IS_RECORDING]) view = VIEWS.RECORDING;

  // If current tab is wiki and we're on results, honor it.
  if (view === VIEWS.RESULTS && currentTab === "wiki") {
    $$("main#app .view").forEach((el) => { el.hidden = el.dataset.view !== "wiki"; });
    renderHeader(view);
    await renderTabNav(view);
    await renderWiki();
    return;
  }

  showView(view);

  if (view === VIEWS.RECORDING) await renderRecording();
  if (view === VIEWS.RESULTS) await renderResults();
  if (view === VIEWS.ERROR) await renderError();
}

// --- Wire up ---

document.addEventListener("DOMContentLoaded", () => {
  $("#start-btn").addEventListener("click", startSession);
  $("#hero-start-btn").addEventListener("click", startSession);
  $("#stop-btn").addEventListener("click", stopAndAnalyze);
  $("#reset-btn").addEventListener("click", resetToIdle);
  $("#error-reset-btn").addEventListener("click", resetToIdle);
  $("#load-fixture-btn").addEventListener("click", loadFixture);
  $("#export-md-btn").addEventListener("click", downloadMarkdown);

  // Demo wiki shortcut — visible only with ?demo in URL
  const params = new URLSearchParams(window.location.search);
  if (params.has("demo")) {
    const btn = $("#load-demo-wiki-btn");
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", loadDemoWikiFlow);
    }
  }

  // Auto-switch to wiki tab if ?tab=wiki
  if (params.get("tab") === "wiki") currentTab = "wiki";

  // Tab nav clicks
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });

  route();
});

// Live-update visit counter + react to state changes from other tabs/background.
chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEYS.SESSION_LOG]) {
    const el = document.getElementById("visit-count");
    if (el) el.textContent = String(changes[STORAGE_KEYS.SESSION_LOG].newValue?.length ?? 0);
  }
  if (changes[STORAGE_KEYS.VIEW] || changes[STORAGE_KEYS.IS_RECORDING] || changes[STORAGE_KEYS.WIKI]) {
    route();
  }
});
