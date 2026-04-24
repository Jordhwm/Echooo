// Echooo popup — minimal Start/Stop + "open full app" shortcut.
// Heavy work (the analyze fetch) runs in background.js so it survives
// the popup closing. The full-tab app renders the SOPs.

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
  $$(".popup-view").forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
}

async function renderCounter() {
  const { [STORAGE_KEYS.SESSION_LOG]: log = [] } = await chrome.storage.local.get(
    STORAGE_KEYS.SESSION_LOG,
  );
  const el = $("#counter");
  if (el) el.textContent = String(log.length);
}

async function route() {
  const state = await chrome.storage.local.get([
    STORAGE_KEYS.IS_RECORDING,
    STORAGE_KEYS.VIEW,
  ]);
  let view = state[STORAGE_KEYS.VIEW] || VIEWS.IDLE;
  if (state[STORAGE_KEYS.IS_RECORDING]) view = VIEWS.RECORDING;
  showView(view);
  if (view === VIEWS.RECORDING) await renderCounter();
}

async function startSession() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_RECORDING]: true,
    [STORAGE_KEYS.SESSION_LOG]: [],
    [STORAGE_KEYS.ANALYSIS]: null,
    [STORAGE_KEYS.ERROR]: null,
    [STORAGE_KEYS.VIEW]: VIEWS.RECORDING,
  });
  await route();
}

async function stopAndAnalyze() {
  // Background does the fetch so it survives the popup closing.
  await chrome.runtime.sendMessage({ cmd: "stop-and-analyze" });
  await chrome.runtime.sendMessage({ cmd: "open-app" });
  // Close popup — the app tab will show the analyzing spinner and results.
  window.close();
}

async function resetToIdle() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_RECORDING]: false,
    [STORAGE_KEYS.SESSION_LOG]: [],
    [STORAGE_KEYS.ANALYSIS]: null,
    [STORAGE_KEYS.ERROR]: null,
    [STORAGE_KEYS.VIEW]: VIEWS.IDLE,
  });
  await route();
}

async function openApp(tab) {
  await chrome.runtime.sendMessage({ cmd: "open-app", tab });
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  $("#start-btn").addEventListener("click", startSession);
  $("#stop-btn").addEventListener("click", stopAndAnalyze);
  $("#new-session-btn").addEventListener("click", resetToIdle);
  $("#err-reset-btn").addEventListener("click", resetToIdle);
  $("#open-app-btn").addEventListener("click", () => openApp());
  $("#open-wiki-btn").addEventListener("click", () => openApp("wiki"));
  route();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEYS.SESSION_LOG]) {
    const el = $("#counter");
    if (el) el.textContent = String(changes[STORAGE_KEYS.SESSION_LOG].newValue?.length ?? 0);
  }
  if (changes[STORAGE_KEYS.VIEW] || changes[STORAGE_KEYS.IS_RECORDING]) {
    route();
  }
});
