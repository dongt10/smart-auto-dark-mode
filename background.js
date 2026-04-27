// Auto Dark Mode — background service worker
// Mostly a no-op for v1: state lives in chrome.storage.local and is read by
// the content script. We hook onInstalled to set the default enabled flag.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['enabled'], (res) => {
    if (res.enabled === undefined) {
      chrome.storage.local.set({ enabled: true });
    }
  });
});
