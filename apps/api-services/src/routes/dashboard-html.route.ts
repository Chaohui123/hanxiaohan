// ============================================================
// ONZO 轻量化运营看板 — 单文件零依赖 HTML
// Features: 多店铺切换, COS容量, 批量重跑, 实时告警
// ============================================================

import { Router } from "express";

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ONZO — Ozon 跨境自动化运营看板</title>
<style>
:root{--bg:#0f1117;--card:#1a1d28;--border:#2a2d3a;--text:#e1e4ed;--muted:#8890a4;--green:#10b981;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#8b5cf6}
*{margin:0;padding:0;box-sizing:border-box}
body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
header{background:var(--card);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
header h1{font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}
header h1 span{color:var(--muted);font-size:12px;font-weight:400}
.toolbar{display:flex;gap:10px;align-items:center}
select,input,button{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;font-size:12px;outline:none}
select:focus,input:focus{border-color:var(--blue)}
button{cursor:pointer;font-weight:500;transition:all .15s}
button:hover{opacity:.85}
.btn-primary{background:var(--blue);border-color:var(--blue);color:#fff}
.btn-danger{background:var(--red);border-color:var(--red);color:#fff}
.btn-amber{background:var(--amber);border-color:var(--amber);color:#000}
.main{padding:16px 20px;max-width:1400px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;position:relative}
.card .icon{font-size:20px;margin-bottom:6px}
.card .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.card .value{font-size:26px;font-weight:700}
.card .sub{font-size:11px;color:var(--muted);margin-top:2px}
.card.blink-red{animation:pulse 1s infinite}
@keyframes pulse{0%,100%{border-color:var(--red)}50%{border-color:transparent}}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:900px){.row{grid-template-columns:1fr}}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px}
.section h2{font-size:14px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:500;font-size:11px}
tr:hover{background:rgba(255,255,255,.02)}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.badge-green{background:rgba(16,185,129,.15);color:var(--green)}
.badge-red{background:rgba(239,68,68,.15);color:var(--red)}
.badge-amber{background:rgba(245,158,11,.15);color:var(--amber)}
.badge-blue{background:rgba(59,130,246,.15);color:var(--blue)}
.empty{text-align:center;color:var(--muted);padding:30px;font-size:13px}
.progress-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px}
.progress-fill{height:100%;border-radius:3px;transition:width .5s}
.toast{position:fixed;top:16px;right:16px;z-index:999;display:flex;flex-direction:column;gap:8px}
.toast-item{padding:12px 18px;border-radius:8px;font-size:13px;font-weight:500;animation:slideIn .3s ease;max-width:400px}
.toast-error{background:var(--red);color:#fff}
.toast-warn{background:var(--amber);color:#000}
.toast-info{background:var(--blue);color:#fff}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.retry-panel{display:none;margin-top:12px}
.retry-panel.active{display:block}
.retry-actions{display:flex;gap:8px;margin-top:10px}
.refresh-text{text-align:center;color:var(--muted);font-size:11px;padding:16px 0 8px}
</style>
</head>
<body>

<header>
  <h1>&#128722; ONZO <span>Ozon 跨境电商自动化运营看板</span></h1>
  <div class="toolbar">
    <select id="storeSelect" onchange="onStoreChange()"><option value="">全部店铺</option></select>
    <input id="searchInput" placeholder="搜索商品/SKU..." style="width:160px">
    <button class="btn-primary" onclick="refreshAll()">&#x21bb; 刷新</button>
  </div>
</header>

<div id="toast" class="toast"></div>

<div class="main">
  <!-- KPI 卡片行 -->
  <div class="grid" id="kpiCards"></div>

  <!-- 左右双栏 -->
  <div class="row">
    <div>
      <!-- 告警面板 -->
      <div class="section" id="alertPanel" style="display:none">
        <h2>&#128680; 实时告警</h2>
        <div id="alerts"></div>
      </div>

      <!-- 批量重跑 -->
      <div class="section">
        <h2>&#128260; 批量失败商品重跑</h2>
        <div id="retryPanel">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button onclick="loadFailedTasks()">加载失败任务</button>
            <button class="btn-primary" onclick="retryAll()">&#9654; 一键重跑全部</button>
            <button class="btn-amber" onclick="retryApiErrors()">&#9654; 重跑API错误</button>
            <button class="btn-danger" onclick="retryValidation()">&#9654; 重跑校验错误</button>
            <span style="font-size:11px;color:var(--muted)" id="retryStatus"></span>
          </div>
          <div style="margin-top:8px;max-height:200px;overflow-y:auto">
            <table id="failedTable"><tr><td class="empty">点击"加载失败任务"查看</td></tr></table>
          </div>
        </div>
      </div>

      <!-- 上架记录 -->
      <div class="section">
        <h2>&#128230; 今日上架记录</h2>
        <div style="max-height:250px;overflow-y:auto"><table id="listingTable"><tr><td class="empty">加载中...</td></tr></table></div>
      </div>
    </div>

    <div>
      <!-- 多店铺汇总 -->
      <div class="section">
        <h2>&#127970; 多店铺汇总</h2>
        <div style="max-height:200px;overflow-y:auto"><table id="storeTable"><tr><td class="empty">加载中...</td></tr></table></div>
      </div>

      <!-- COS 存储 -->
      <div class="section">
        <h2>&#9729; COS 素材存储</h2>
        <div class="grid" style="grid-template-columns:1fr 1fr 1fr">
          <div class="card">
            <div class="label">图片总数</div>
            <div class="value" id="cosImages">-</div>
          </div>
          <div class="card">
            <div class="label">存储占用</div>
            <div class="value" id="cosSize">-</div>
          </div>
          <div class="card">
            <div class="label">死信队列</div>
            <div class="value" id="cosDead">-</div>
          </div>
        </div>
        <div class="progress-bar" style="margin-top:8px;height:8px">
          <div class="progress-fill" id="cosBar" style="width:0%;background:var(--blue)"></div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px" id="cosDetail"></div>
      </div>

      <!-- Token 消耗 -->
      <div class="section">
        <h2>&#129504; LLM Token 消耗</h2>
        <div id="tokenCards" class="grid" style="grid-template-columns:1fr 1fr"></div>
      </div>
    </div>
  </div>
</div>

<div class="refresh-text" id="refreshTime"></div>

<script>
// ---- State ----
let currentStore = "";
let failedTasks = [];
let refreshTimer;

// ---- Init ----
async function refreshAll() {
  try {
    await Promise.all([loadKPIs(), loadStores(), loadAlerts(), loadCOS(), loadTokens()]);
    document.getElementById("refreshTime").textContent = "更新: " + new Date().toLocaleTimeString("zh-CN");
  } catch(e) {
    toast("数据加载失败: " + e.message, "error");
  }
}

// ---- 1. KPI Cards ----
async function loadKPIs() {
  const res = await fetch("/api/dashboard").then(r => r.json());
  const d = res.data || {};
  const q = d.queue || {};
  document.getElementById("kpiCards").innerHTML =
    '<div class="card"><div class="icon">&#128203;</div><div class="label">队列中</div><div class="value" style="color:var(--amber)">' + (q.queued||0) + '</div><div class="sub">处理中: ' + (q.processing||0) + '</div></div>' +
    '<div class="card"><div class="icon">&#128200;</div><div class="label">今日上架</div><div class="value" style="color:var(--green)">' + (d.todayListings||0) + '</div><div class="sub">Token: ' + (d.todayTokens||0).toLocaleString() + '</div></div>' +
    '<div class="card"><div class="icon">&#128666;</div><div class="label">待处理订单</div><div class="value" style="color:' + ((d.pendingOrders||0)>10?'var(--red)':'var(--green)') + '">' + (d.pendingOrders||0) + '</div></div>' +
    '<div class="card"><div class="icon">&#128738;</div><div class="label">低库存SKU</div><div class="value" style="color:' + ((d.lowStockProducts||0)>5?'var(--red)':'var(--green)') + '">' + (d.lowStockProducts||0) + '</div></div>' +
    '<div class="card"><div class="icon">&#127970;</div><div class="label">活跃店铺</div><div class="value" id="activeStoreCount">-</div></div>' +
    '<div class="card"><div class="icon">&#9889;</div><div class="label">失败任务</div><div class="value" style="color:' + ((q.failed||0)>0?'var(--red)':'var(--muted)') + '" id="failedCount">' + (q.failed||0) + '</div></div>';
}

// ---- 2. 多店铺 ----
async function loadStores() {
  const [storesRes, summaryRes] = await Promise.all([
    fetch("/api/stores").then(r => r.json()),
    fetch("/api/stores/summary").then(r => r.json()).catch(() => ({ data: {} }))
  ]);
  const stores = storesRes.data || [];
  const summary = summaryRes.data || {};

  // Dropdown
  const sel = document.getElementById("storeSelect");
  sel.innerHTML = '<option value="">全部店铺 (' + stores.length + ')</option>';
  stores.forEach(s => {
    sel.innerHTML += '<option value="' + s.store_id + '">' + (s.store_name || s.store_id) + '</option>';
  });
  document.getElementById("activeStoreCount").textContent = stores.length;

  // Summary table
  const totals = summary.totals || {};
  const perStore = summary.perStore || [];
  document.getElementById("storeTable").innerHTML = perStore.length > 0
    ? '<table><tr><th>店铺</th><th>分组</th><th>活跃任务</th><th>失败</th><th>状态</th></tr>' +
      perStore.map(s => '<tr><td>' + (s.store_name || s.store_id || '-') + '</td><td>' + (s.group_name || '-') + '</td><td>' + (s.activeTasks || 0) + '</td><td>' + (s.failedTasks || 0) + '</td><td>' + (s.active ? '<span class="badge badge-green">活跃</span>' : '<span class="badge badge-red">停用</span>') + '</td></tr>').join("") +
      '</table>'
    : '<div class="empty">暂无店铺 — POST /api/stores 添加</div>';
}

// ---- 3. 告警面板 ----
async function loadAlerts() {
  const alerts = [];
  const alertDiv = document.getElementById("alerts");

  // Check token limit
  try {
    const statsRes = await fetch("/api/stats/llm").then(r => r.json());
    const todayTokens = statsRes.data?.todayTokens || 0;
    const limit = 500000;
    if (todayTokens > limit * 0.8) {
      alerts.push({ level: "error", msg: "Token超限: 已用 " + todayTokens.toLocaleString() + " / " + limit.toLocaleString() + " (" + Math.round(todayTokens/limit*100) + "%)" });
    }
  } catch {}

  // Check failed tasks
  try {
    const taskRes = await fetch("/api/task/queue/stats").then(r => r.json());
    if (taskRes.data?.failed > 0) {
      alerts.push({ level: "warn", msg: "失败任务: " + taskRes.data.failed + " 个待重试" });
    }
  } catch {}

  // Check 429 from circuit breaker
  try {
    const dbRes = await fetch("/api/dashboard").then(r => r.json());
    if (dbRes.data?.lowStockProducts > 5) {
      alerts.push({ level: "error", msg: "低库存告警: " + dbRes.data.lowStockProducts + " 个SKU库存不足5件" });
    }
  } catch {}

  if (alerts.length > 0) {
    document.getElementById("alertPanel").style.display = "block";
    alertDiv.innerHTML = alerts.map(a =>
      '<div class="card ' + (a.level === "error" ? "blink-red" : "") + '" style="margin-bottom:6px;padding:10px">' +
      (a.level === "error" ? "&#128308; " : "&#128993; ") + a.msg + '</div>'
    ).join("");
    // Toast for critical
    const critical = alerts.filter(a => a.level === "error");
    critical.forEach(a => toast(a.msg, "error"));
  }
}

// ---- 4. COS 存储 ----
async function loadCOS() {
  try {
    // COS stats from backend (if COS configured)
    const res = await fetch("/api/stats/cos").then(r => r.json()).catch(() => ({ data: null }));
    const d = res.data || { images: 0, totalSizeBytes: 0, deadLetters: 0, maxSizeBytes: 10 * 1024 * 1024 * 1024 };

    document.getElementById("cosImages").textContent = (d.images || 0).toLocaleString();
    document.getElementById("cosDead").textContent = (d.deadLetters || 0);

    const sizeMB = (d.totalSizeBytes || 0) / (1024 * 1024);
    const maxMB = (d.maxSizeBytes || 10*1024*1024*1024) / (1024 * 1024);
    document.getElementById("cosSize").textContent = sizeMB < 1 ? (sizeMB*1024).toFixed(0) + " KB" : sizeMB.toFixed(1) + " MB";

    const pct = Math.min(100, (sizeMB / maxMB * 100));
    const bar = document.getElementById("cosBar");
    bar.style.width = pct + "%";
    bar.style.background = pct > 80 ? "var(--red)" : pct > 50 ? "var(--amber)" : "var(--blue)";
    document.getElementById("cosDetail").textContent = "已用 " + pct.toFixed(1) + "% / " + (maxMB/1024).toFixed(0) + " GB 总容量";
  } catch {
    document.getElementById("cosImages").textContent = "N/A";
    document.getElementById("cosSize").textContent = "N/A";
    document.getElementById("cosDead").textContent = "N/A";
    document.getElementById("cosDetail").textContent = "COS 未配置或不可用";
  }
}

// ---- 5. Token 消耗 ----
async function loadTokens() {
  try {
    const res = await fetch("/api/stats/llm").then(r => r.json());
    const d = res.data || {};
    document.getElementById("tokenCards").innerHTML =
      '<div class="card"><div class="label">今日消耗</div><div class="value">' + (d.todayTokens || 0).toLocaleString() + '</div><div class="sub">预估费用 \$' + (d.todayCost || 0).toFixed(3) + '</div></div>' +
      '<div class="card"><div class="label">本月累计</div><div class="value">' + (d.monthTokens || 0).toLocaleString() + '</div><div class="sub">限额 ' + (d.dailyLimit || 0).toLocaleString() + '/天</div></div>';
  } catch {
    document.getElementById("tokenCards").innerHTML = '<div class="card"><div class="label">Token 统计</div><div class="value" style="color:var(--muted)">N/A</div></div>';
  }
}

// ---- 6. 失败任务/批量重跑 ----
async function loadFailedTasks() {
  const store = currentStore ? "&storeId=" + currentStore : "";
  try {
    const res = await fetch("/api/task/failed?" + store).then(r => r.json());
    failedTasks = res.data || [];
    renderFailedTable();
    document.getElementById("retryStatus").textContent = "已加载 " + failedTasks.length + " 条";
  } catch(e) {
    toast("加载失败: " + e.message, "error");
  }
}

function renderFailedTable() {
  const tbody = document.getElementById("failedTable");
  if (failedTasks.length === 0) {
    tbody.innerHTML = '<tr><td class="empty">&#10003; 无失败任务</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><th>任务ID</th><th>类型</th><th>错误</th><th>重试</th><th>状态</th></tr>' +
    failedTasks.slice(0, 30).map(t =>
      '<tr><td style="font-family:monospace;font-size:10px">' + (t.id||'').substring(0,12) + '...</td>' +
      '<td>' + (t.taskType || t.task_type || '-') + '</td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (t.errorMessage||'') + '">' + (t.errorMessage||'').substring(0,60) + '</td>' +
      '<td>' + (t.retryCount || t.retry_count || 0) + '/' + (t.maxRetries || 3) + '</td>' +
      '<td><span class="badge ' + (t.status === 'pending_retry' ? 'badge-amber' : 'badge-red') + '">' + (t.status || '-') + '</span></td></tr>'
    ).join("");
  if (failedTasks.length > 30) {
    tbody.innerHTML += '<tr><td colspan="5" style="text-align:center;color:var(--muted)">... 还有 ' + (failedTasks.length - 30) + ' 条</td></tr>';
  }
}

async function retryAll() {
  await doRetry({ filterType: "all_retryable" });
}

async function retryApiErrors() {
  await doRetry({ filterType: "api_error" });
}

async function retryValidation() {
  await doRetry({ filterType: "validation" });
}

async function doRetry(body) {
  document.getElementById("retryStatus").textContent = "重试中...";
  try {
    const res = await fetch("/api/task/deadletter/retry-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(r => r.json());
    const retried = res.data?.retried || 0;
    const total = res.data?.total || 0;
    document.getElementById("retryStatus").textContent = "已重跑 " + retried + "/" + total;
    toast("重跑完成: " + retried + " 个成功", retried === total ? "info" : "warn");
    await loadFailedTasks();
    await refreshAll();
  } catch(e) {
    toast("重跑失败: " + e.message, "error");
    document.getElementById("retryStatus").textContent = "失败";
  }
}

// ---- Utils ----
function onStoreChange() {
  currentStore = document.getElementById("storeSelect").value;
  refreshAll();
  loadFailedTasks();
}

function toast(msg, level) {
  const div = document.createElement("div");
  div.className = "toast-item toast-" + (level || "info");
  div.textContent = msg;
  document.getElementById("toast").appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

// ---- Start ----
refreshAll();
loadFailedTasks();
refreshTimer = setInterval(() => { refreshAll(); loadAlerts(); }, 30_000);
</script>
</body>
</html>`;

export function createDashboardHtmlRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(HTML);
  });
  return router;
}
