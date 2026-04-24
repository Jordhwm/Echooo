// Echooo app page — full-tab UI driven by chrome.storage.local state.
// The analyze fetch lives in background.js (single source of truth).

const STORAGE_KEYS = {
  IS_RECORDING: "is_recording",
  SESSION_LOG: "session_log",
  ANALYSIS: "analysis_result",
  VIEW: "view_state",
  ERROR: "last_error",
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

function showView(name) {
  $$(".view").forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
  renderHeader(name);
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

// --- Actions ---

async function startSession() {
  await setState({
    [STORAGE_KEYS.IS_RECORDING]: true,
    [STORAGE_KEYS.SESSION_LOG]: [],
    [STORAGE_KEYS.ANALYSIS]: null,
    [STORAGE_KEYS.ERROR]: null,
    [STORAGE_KEYS.VIEW]: VIEWS.RECORDING,
  });
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
  route();
});

// Live-update visit counter + react to state changes from other tabs/background.
chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEYS.SESSION_LOG]) {
    const el = document.getElementById("visit-count");
    if (el) el.textContent = String(changes[STORAGE_KEYS.SESSION_LOG].newValue?.length ?? 0);
  }
  if (changes[STORAGE_KEYS.VIEW] || changes[STORAGE_KEYS.IS_RECORDING]) {
    route();
  }
});
