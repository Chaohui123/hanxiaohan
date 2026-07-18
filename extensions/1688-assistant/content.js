// ============================================================
// ONZO 1688 Content Script — Extract product data
// ============================================================
(function () {
  "use strict";

  // ---- Product data extraction ----
  function extractProduct() {
    const data = {
      sourceUrl: location.href,
      title: "",
      price: { min: 0, max: 0 },
      images: [],
      specs: [],
      weight: "",
      supplier: "",
      shipping: "",
      stock: "",
      category: "",
    };

    // Title
    const titleEl = document.querySelector(".offer-title, [data-module-name='offerHeader'] h1, .title-name");
    if (titleEl) data.title = titleEl.textContent.trim();

    // Price
    const priceEl = document.querySelector(".price-original, .mod-detail-price .value, [data-range]");
    if (priceEl) {
      const ptext = priceEl.textContent.replace(/[^0-9.]/g, "").trim();
      const p = parseFloat(ptext) || 0;
      data.price = { min: p, max: p };
    }

    // Wholesale prices (ranges)
    const priceRanges = document.querySelectorAll(".price-range-item .value, .mod-detail-price .detail");
    if (priceRanges.length > 0) {
      const prices = [];
      priceRanges.forEach(el => {
        const v = parseFloat(el.textContent.replace(/[^0-9.]/g, "")) || 0;
        if (v > 0) prices.push(v);
      });
      if (prices.length >= 2) {
        data.price = { min: Math.min(...prices), max: Math.max(...prices) };
      } else if (prices.length === 1) {
        data.price = { min: prices[0], max: prices[0] };
      }
    }

    // Images
    document.querySelectorAll(".detail-gallery img, .main-gallery img, .mod-detail-gallery img").forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && src.includes("alicdn.com")) {
        data.images.push(src.replace(/_\d+x\d+\.(jpg|png)/, ".$1"));
      }
    });

    // Specifications
    document.querySelectorAll(".mod-detail-attributes tr, .sku-item, .spec-item").forEach(row => {
      const name = row.querySelector(".name, .label, .title")?.textContent?.trim() || "";
      const value = row.querySelector(".value, .content")?.textContent?.trim() || "";
      if (name && value) data.specs.push({ name, value });
    });

    // Try to get SKU data from page script (window.__INITIAL_STATE__)
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const match = s.textContent?.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
        if (match) {
          const state = JSON.parse(match[1]);
          const offerInfo = state?.offer?.offerInfo || {};
          if (offerInfo.title) data.title = offerInfo.title;
          if (offerInfo.images) data.images = offerInfo.images;
          if (offerInfo.skuProps) {
            data.specs = offerInfo.skuProps.map((p) => ({ name: p.prop || "", value: p.value || "" }));
          }
          break;
        }
      }
    } catch (e) { /* page state not available */ }

    return data;
  }

  // ---- Floating panel UI ----
  function createPanel() {
    if (document.getElementById("onzo-panel")) return;
    const panel = document.createElement("div");
    panel.id = "onzo-panel";
    panel.innerHTML = `
      <style>
        #onzo-panel { position:fixed; bottom:20px; right:20px; z-index:99999;
          background:#1a1d28; border:1px solid #2a2d3a; border-radius:12px; padding:16px;
          color:#e1e4ed; font:13px/1.6 sans-serif; width:280px; box-shadow:0 8px 32px rgba(0,0,0,.4); }
        #onzo-panel h3 { margin:0 0 8px; font-size:14px; display:flex; align-items:center; gap:6px; }
        #onzo-panel .btn { display:block; width:100%; margin:6px 0; padding:8px 12px;
          border-radius:8px; border:none; cursor:pointer; font-size:12px; font-weight:500; }
        .btn-primary { background:#3b82f6; color:#fff; }
        .btn-success { background:#10b981; color:#fff; }
        .btn-purple { background:#8b5cf6; color:#fff; }
        .btn-secondary { background:#374151; color:#e1e4ed; }
        #onzo-status { font-size:11px; color:#8890a4; margin-top:4px; min-height:18px; }
        #onzo-price { font-size:12px; color:#f59e0b; margin:4px 0; }
        #onzo-close { position:absolute; top:8px; right:12px; cursor:pointer; color:#8890a4; font-size:16px; }
      </style>
      <span id="onzo-close" onclick="document.getElementById('onzo-panel').remove()">×</span>
      <h3>📦 ONZO 采购助手</h3>
      <div id="onzo-price"></div>
      <button class="btn btn-primary" id="onzo-sync">📤 同步至ERP</button>
      <button class="btn btn-purple" id="onzo-analyze">🔍 预览选品分析</button>
      <button class="btn btn-success" id="onzo-list">🚀 一键上架Ozon</button>
      <div id="onzo-status">已识别商品，等待操作...</div>
    `;
    document.body.appendChild(panel);

    // Buttons
    const product = window.__onzoProduct || {};
    document.getElementById("onzo-price").textContent =
      `¥${product.price?.min || "?"}${product.price?.max > product.price?.min ? ` - ¥${product.price.max}` : ""} | ${product.images?.length || 0} 张图`;

    document.getElementById("onzo-sync").onclick = () => syncToBackend(product);
    document.getElementById("onzo-analyze").onclick = () => previewAnalysis(product);
    document.getElementById("onzo-list").onclick = () => autoList(product);
  }

  // ---- API calls ----
  const API_BASE = "https://huashangshangmao.top";

  async function getApiKey() {
    try {
      const result = await chrome?.storage?.local?.get("apiKey");
      return result?.apiKey || "";
    } catch { return ""; }
  }

  async function syncToBackend(product) {
    setStatus("⏳ 同步中...");
    try {
      const apiKey = await getApiKey();
      const resp = await fetch(`${API_BASE}/api/crawl/plugin-1688`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify(product),
      });
      const data = await resp.json();
      if (data.success) {
        setStatus(`✅ 已同步! 利润 ¥${data.data?.profitRub || "?"} | 打分 ${data.data?.score || "?"}分`);
        chrome?.storage?.local?.set({ lastSync: { time: Date.now(), product } });
      } else {
        setStatus(`❌ ${data.error?.message || "同步失败"}`);
      }
    } catch (e) {
      // Queue for retry
      chrome?.storage?.local?.get("pendingQueue", (result) => {
        const queue = result.pendingQueue || [];
        queue.push({ product, time: Date.now() });
        chrome?.storage?.local?.set({ pendingQueue: queue });
      });
      setStatus("⚠️ 网络异常，已加入离线队列");
    }
  }

  async function previewAnalysis(product) {
    setStatus("⏳ 分析中...");
    try {
      const apiKey = await getApiKey();
      const resp = await fetch(`${API_BASE}/api/market/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ keyword: product.title.slice(0, 30), sourceUrl: product.sourceUrl }),
      });
      const data = await resp.json();
      if (data.success) {
        setStatus(`✅ 评分 ${data.data?.overallScore || "?"}/100 | ${data.data?.recommendation || ""}`);
        window.open(`${API_BASE}/market?keyword=${encodeURIComponent(product.title.slice(0, 20))}`, "_blank");
      } else {
        setStatus("❌ 分析失败");
      }
    } catch (e) { setStatus("⚠️ 网络异常"); }
  }

  async function autoList(product) {
    setStatus("⏳ 上架中...");
    try {
      const apiKey = await getApiKey();
      const resp = await fetch(`${API_BASE}/api/direct-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          titleCn: product.title,
          sourceUrl: product.sourceUrl,
          priceCny: product.price?.min || 0,
          weightG: 500,
          ozonPriceRub: Math.round((product.price?.min || 50) * 80),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setStatus(`🚀 已上架! productId: ${data.data?.productId || "OK"}`);
        window.open(`https://seller.ozon.ru/app/products`, "_blank");
      } else {
        setStatus(`❌ ${data.error?.message || "上架失败"}`);
      }
    } catch (e) { setStatus("⚠️ 网络异常"); }
  }

  function setStatus(msg) {
    const el = document.getElementById("onzo-status");
    if (el) el.textContent = msg;
  }

  // ---- Init ----
  const product = extractProduct();
  window.__onzoProduct = product;
  createPanel();

  // Retry pending queue
  chrome?.storage?.local?.get("pendingQueue", (result) => {
    const queue = result.pendingQueue || [];
    if (queue.length > 0) {
      setStatus(`📋 离线队列: ${queue.length} 条待同步`);
      // Auto-retry one by one
      (async () => {
        for (let i = queue.length - 1; i >= 0; i--) {
          try {
            await syncToBackend(queue[i].product);
            queue.splice(i, 1);
          } catch { break; }
        }
        chrome?.storage?.local?.set({ pendingQueue: queue });
      })();
    }
  });
})();
