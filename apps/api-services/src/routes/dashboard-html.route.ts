// ============================================================
// Lightweight HTML Dashboard — zero-framework ops panel
// Served at GET / — fetches /api/dashboard for live data
// ============================================================

import { Router } from "express";

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ONZO — Ozon 跨境自动化运营看板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:#f5f7fa;color:#1a1a2e}
header{background:#1a1a2e;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:18px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:20px 24px}
.card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card .label{font-size:12px;color:#888;text-transform:uppercase;margin-bottom:6px}
.card .value{font-size:28px;font-weight:700}
.card .sub{font-size:13px;color:#666;margin-top:4px}
.green{color:#10b981}.red{color:#ef4444}.amber{color:#f59e0b}
.section{margin:0 24px 20px}
.section h2{font-size:16px;margin-bottom:12px;color:#333}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #eee;font-size:13px}
th{background:#f8f9fb;color:#666;font-weight:600}
tr:last-child td{border-bottom:none}
.refresh{color:#94a3b8;font-size:12px;margin-top:8px}
.btn{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}
.btn:hover{background:#2563eb}
.empty{text-align:center;color:#999;padding:40px}
</style>
</head>
<body>
<header>
  <h1>🛒 ONZO — Ozon 跨境电商自动化运营看板</h1>
  <button class="btn" onclick="location.reload()">刷新</button>
</header>

<div class="grid" id="cards"></div>

<div class="section"><h2>📦 今日上架记录</h2><div id="listings"><div class="empty">加载中...</div></div></div>
<div class="section"><h2>📊 AI Token 消耗</h2><div id="tokens"><div class="empty">加载中...</div></div></div>
<div class="section"><h2>🏪 店铺管理</h2><div id="stores"><div class="empty">加载中...</div></div></div>

<div class="refresh" style="text-align:center;padding-bottom:20px" id="refreshTime"></div>

<script>
async function load() {
  try {
    const [dash, stores] = await Promise.all([
      fetch("/api/dashboard").then(r => r.json()),
      fetch("/api/stores").then(r => r.json())
    ]);

    // Cards
    const q = dash.data.queue;
    document.getElementById("cards").innerHTML =
      '<div class="card"><div class="label">队列中</div><div class="value amber">' + q.queued + '</div></div>' +
      '<div class="card"><div class="label">处理中</div><div class="value" style="color:#3b82f6">' + q.processing + '</div></div>' +
      '<div class="card"><div class="label">今日上架</div><div class="value green">' + dash.data.todayListings + '</div><div class="sub">今日 Token: ' + (dash.data.todayTokens || 0).toLocaleString() + '</div></div>' +
      '<div class="card"><div class="label">待处理订单</div><div class="value ' + (dash.data.pendingOrders > 10 ? 'red' : 'green') + '">' + dash.data.pendingOrders + '</div></div>' +
      '<div class="card"><div class="label">低库存 SKU</div><div class="value ' + (dash.data.lowStockProducts > 5 ? 'red' : 'green') + '">' + dash.data.lowStockProducts + '</div></div>' +
      '<div class="card"><div class="label">活跃店铺</div><div class="value">' + (stores.data || []).length + '</div></div>';

    // Listings placeholder
    document.getElementById("listings").innerHTML = dash.data.todayListings > 0
      ? '<table><tr><th>状态</th></tr><tr><td>' + dash.data.todayListings + ' 条上架记录</td></tr></table>'
      : '<div class="empty">今日暂无上架记录</div>';

    // Tokens
    document.getElementById("tokens").innerHTML = dash.data.todayTokens > 0
      ? '<table><tr><th>指标</th><th>数值</th></tr><tr><td>今日 Token 消耗</td><td>' + dash.data.todayTokens.toLocaleString() + '</td></tr></table>'
      : '<div class="empty">今日暂无 AI 调用</div>';

    // Stores
    const storeList = stores.data || [];
    document.getElementById("stores").innerHTML = storeList.length > 0
      ? '<table><tr><th>店铺 ID</th><th>名称</th><th>分组</th><th>状态</th></tr>' +
        storeList.map(s => '<tr><td>' + s.store_id + '</td><td>' + (s.store_name || "-") + '</td><td>' + (s.group_name || "-") + '</td><td>' + (s.active ? "✅ 活跃" : "⛔ 停用") + '</td></tr>').join("") +
        '</table>'
      : '<div class="empty">暂无店铺配置 — 请通过 POST /api/stores 添加</div>';

    document.getElementById("refreshTime").textContent = "数据更新时间: " + new Date().toLocaleTimeString("zh-CN");
  } catch(e) {
    document.getElementById("cards").innerHTML = '<div class="card"><div class="value red">连接失败</div><div class="sub">' + e.message + '</div></div>';
  }
}
load();
setInterval(load, 30000);
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
