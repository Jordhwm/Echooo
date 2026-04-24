// Echooo background service worker — logs tab activity while recording.
// Filter is applied at analysis time, not capture time (brief §9).

const STORAGE_KEYS = {
  IS_RECORDING: "is_recording",
  SESSION_LOG: "session_log",
  ANALYSIS: "analysis_result",
  VIEW: "view_state",
  ERROR: "last_error",
  WIKI: "wiki_sops",
};

const BACKEND_URL = "https://echooo-chi.vercel.app/api/analyze";
const APP_URL = chrome.runtime.getURL("app.html");

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function appendEvent(tab, eventType) {
  if (!tab || !tab.url) return;
  if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;

  const { [STORAGE_KEYS.IS_RECORDING]: isRecording } = await chrome.storage.local.get(
    STORAGE_KEYS.IS_RECORDING
  );
  if (!isRecording) return;

  const event = {
    timestamp: Date.now(),
    url: tab.url,
    domain: domainOf(tab.url),
    title: tab.title || "",
    event_type: eventType,
  };

  const { [STORAGE_KEYS.SESSION_LOG]: log = [] } = await chrome.storage.local.get(
    STORAGE_KEYS.SESSION_LOG
  );
  log.push(event);
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_LOG]: log });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await appendEvent(tab, "tab_activated");
  } catch {
    /* tab may have closed */
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  await appendEvent(tab, "tab_updated");
});

async function openAppTab(requestedTab) {
  // Append ?tab= so the app routes to the right view on load.
  const targetUrl = requestedTab ? `${APP_URL}?tab=${encodeURIComponent(requestedTab)}` : APP_URL;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(APP_URL));
  if (existing) {
    // If a specific tab was requested, reload with the query param so the app reads it.
    if (requestedTab && !existing.url.includes(`tab=${requestedTab}`)) {
      await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
    } else {
      await chrome.tabs.update(existing.id, { active: true });
    }
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: targetUrl });
  }
}

// Analysis runs in the background so it survives the popup closing and isn't
// bound to any particular tab context. Popup + app tab both trigger via
// chrome.runtime.sendMessage({ cmd: "stop-and-analyze" }).
async function performAnalysis() {
  console.info("[Echooo] analyze: starting");
  await chrome.storage.local.set({
    [STORAGE_KEYS.IS_RECORDING]: false,
    [STORAGE_KEYS.VIEW]: "analyzing",
    [STORAGE_KEYS.ERROR]: null,
  });
  const controller = new AbortController();
  // Vercel maxDuration is 60s; give the client a hair more headroom before
  // aborting so the serverside error comes through when it's the cause.
  const timeoutId = setTimeout(() => controller.abort(), 90_000);
  try {
    const { [STORAGE_KEYS.SESSION_LOG]: log = [], [STORAGE_KEYS.WIKI]: wiki = [] } =
      await chrome.storage.local.get([STORAGE_KEYS.SESSION_LOG, STORAGE_KEYS.WIKI]);
    const payload = { session_log: log };
    if (Array.isArray(wiki) && wiki.length > 0) {
      payload.existing_wiki = wiki;
    }
    console.info(
      `[Echooo] analyze: POST ${BACKEND_URL} events=${log.length} wiki=${(wiki || []).length}`,
    );
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    console.info(
      `[Echooo] analyze: ok, workflows=${data?.workflows?.length ?? 0}`,
    );
    await chrome.storage.local.set({
      [STORAGE_KEYS.ANALYSIS]: data,
      [STORAGE_KEYS.VIEW]: "results",
    });
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "Analyze timed out after 90s. Claude or Vercel may be slow — try again."
      : err?.message || String(err);
    console.error("[Echooo] analyze: failed:", err);
    await chrome.storage.local.set({
      [STORAGE_KEYS.ERROR]: msg,
      [STORAGE_KEYS.VIEW]: "error",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === "stop-and-analyze") {
    performAnalysis();
  } else if (msg?.cmd === "open-app") {
    openAppTab(msg.tab);
  }
  return false;
});

// Fallback for any install where default_popup isn't set (e.g. during dev).
// When a popup is configured, this listener never fires.
chrome.action.onClicked.addListener(() => openAppTab());

async function setRecordingBadge(isRecording) {
  try {
    await chrome.action.setBadgeText({ text: isRecording ? "REC" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e74c3c" });
  } catch {
    /* action API unavailable during service worker teardown */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEYS.IS_RECORDING]) {
    setRecordingBadge(!!changes[STORAGE_KEYS.IS_RECORDING].newValue);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(STORAGE_KEYS.IS_RECORDING);
  if (current[STORAGE_KEYS.IS_RECORDING] === undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.IS_RECORDING]: false });
  }
  await setRecordingBadge(!!current[STORAGE_KEYS.IS_RECORDING]);
});

chrome.runtime.onStartup.addListener(async () => {
  const { [STORAGE_KEYS.IS_RECORDING]: isRecording } = await chrome.storage.local.get(
    STORAGE_KEYS.IS_RECORDING,
  );
  await setRecordingBadge(!!isRecording);
});
