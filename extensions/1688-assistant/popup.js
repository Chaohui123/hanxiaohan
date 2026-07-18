document.getElementById("saveKey").onclick = () => {
  const key = document.getElementById("apiKey").value.trim();
  if (!key) { setStatus("请输入API密钥"); return; }
  chrome.storage.local.set({ apiKey: key }, () => setStatus("✅ 密钥已保存"));
};

document.getElementById("openDashboard").onclick = () => {
  chrome.tabs.create({ url: "https://huashangshangmao.top" });
};

document.getElementById("downloadCrx").onclick = () => {
  chrome.tabs.create({ url: "https://huashangshangmao.top/plugin" });
};

// Load saved key
chrome.storage.local.get("apiKey", (r) => {
  if (r.apiKey) document.getElementById("apiKey").value = r.apiKey;
});

// Check pending queue
chrome.storage.local.get("pendingQueue", (r) => {
  const q = r.pendingQueue || [];
  if (q.length > 0) setStatus(`📋 离线队列: ${q.length} 条待同步`);
});

function setStatus(msg) { document.getElementById("status").textContent = msg; }
