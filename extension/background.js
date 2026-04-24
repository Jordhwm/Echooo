// Echooo background service worker — logs tab activity while recording.
// Filter is applied at analysis time, not capture time (brief §9).

const STORAGE_KEYS = {
  IS_RECORDING: "is_recording",
  SESSION_LOG: "session_log",
};

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

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(STORAGE_KEYS.IS_RECORDING);
  if (current[STORAGE_KEYS.IS_RECORDING] === undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.IS_RECORDING]: false });
  }
});
