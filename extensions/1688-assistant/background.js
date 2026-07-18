// ============================================================
// Background Service Worker — WebSocket relay for 1688 download automation
// ============================================================

const WS_URL = "wss://huashangshangmao.top/ws/plugin-bridge";
const API_BASE = "https://huashangshangmao.top";
let ws = null;
let pluginId = "";
let reconnectTimer = null;

// ---- WebSocket connection ----
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      console.log("[ONZO] WS connected");
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      chrome.storage.local.set({ wsConnected: true });
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "welcome") {
          pluginId = msg.pluginId;
          chrome.storage.local.set({ pluginId });
        } else if (msg.type === "download_cmd") {
          handleDownloadCmd(msg);
        }
      } catch (e) { console.error("[ONZO] WS msg error:", e); }
    };
    ws.onclose = () => {
      chrome.storage.local.set({ wsConnected: false });
      reconnectTimer = setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {
      ws.close();
    };
  } catch (e) { reconnectTimer = setTimeout(connectWS, 5000); }
}

// ---- Download command handler ----
async function handleDownloadCmd(cmd) {
  const { taskId, url, keyword } = cmd;
  console.log("[ONZO] Download cmd:", taskId, url);

  try {
    // Send progress: starting
    sendProgress(taskId, keyword, "downloading", 0, 0, 0);

    // Open product page in new tab
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(r => setTimeout(r, 5000)); // Wait for page load

    // Execute content script to trigger download
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: triggerPluginDownload,
    });

    // Wait for downloads to complete
    await new Promise(r => setTimeout(r, 30000));

    // Close tab
    chrome.tabs.remove(tab.id);

    // Collect downloaded files info
    chrome.downloads.search({ state: "complete", limit: 100 }, (results) => {
      const recentDownloads = results.filter(d => d.endTime && (Date.now() - new Date(d.endTime).getTime()) < 60000);
      sendProgress(taskId, keyword, "complete", recentDownloads.length, recentDownloads.length, 0);
    });
  } catch (e) {
    sendProgress(taskId, keyword, "failed", 0, 0, 1);
    console.error("[ONZO] Download failed:", e);
  }
}

function triggerPluginDownload() {
  // Trigger the 1688 official plugin's download button
  // Look for the plugin's "素材处理" → "图片视频下载" button
  const buttons = document.querySelectorAll("button, a, div[role='button']");
  for (const btn of buttons) {
    const text = btn.textContent || "";
    if (text.includes("图片视频下载") || text.includes("素材处理") || text.includes("直接下载")) {
      btn.click();
      break;
    }
  }
  return { triggered: true };
}

function sendProgress(taskId, keyword, status, totalFiles, successFiles, failedFiles) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: status === "complete" ? "download_complete" : "download_progress",
      taskId, keyword, status, totalFiles, failedFiles, progress: totalFiles > 0 ? Math.round(successFiles / totalFiles * 100) : 0,
      startedAt: new Date().toISOString(),
    }));
  }
}

// ---- Init ----
connectWS();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ apiKey: "" });
});

// Retry pending queue
setInterval(() => {
  chrome.storage.local.get(["pendingQueue", "apiKey"], async (r) => {
    const queue = r.pendingQueue || [];
    if (queue.length === 0) return;
    const apiKey = r.apiKey || "";
    if (!apiKey) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      try {
        const resp = await fetch(`${API_BASE}/api/crawl/plugin-1688`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify(queue[i].product),
        });
        if (resp.ok) queue.splice(i, 1); else break;
      } catch { break; }
    }
    chrome.storage.local.set({ pendingQueue: queue });
  });
}, 60_000);
