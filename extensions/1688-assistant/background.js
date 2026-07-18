// Background service worker for ONZO 1688 extension
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("apiKey", (r) => {
    if (!r.apiKey) {
      chrome.storage.local.set({ apiKey: "" });
    }
  });
});

// Retry pending queue periodically
setInterval(() => {
  chrome.storage.local.get(["pendingQueue", "apiKey"], async (r) => {
    const queue = r.pendingQueue || [];
    if (queue.length === 0) return;
    const apiKey = r.apiKey || "";
    if (!apiKey) return;

    for (let i = queue.length - 1; i >= 0; i--) {
      try {
        const resp = await fetch("https://huashangshangmao.top/api/crawl/plugin-1688", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify(queue[i].product),
        });
        if (resp.ok) queue.splice(i, 1);
        else break; // Stop on auth error
      } catch { break; }
    }
    chrome.storage.local.set({ pendingQueue: queue });
  });
}, 60_000); // Retry every 60s
