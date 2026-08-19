// 61N/66T/DOOR 降价后 <135¥，库存从 CEL陆运3(Small,>135¥专用) 迁到 CEL陆运(Extra Small,≤135¥)
// 与 SOP 记录的 66T 历史误选同一修法：原仓清零 + 目标仓设库存
const { ozon } = require("./ozon-api.cjs");

const SMALL = 1020005021424520;  // CEL陆运3（Small，>135¥ 专用）
const XS = 1020005021424150;     // CEL陆运（Extra Small，≤135¥）

const MOVES = [
  { offer_id: "MAR-YAM-61N-01", product_id: 5328928186, stock: 30 },  // product_id 待替换为真实 product_id
  { offer_id: "MAR-YAM-66T-01", product_id: 5980014152, stock: 25 },
  { offer_id: "CN-HAV-H6-DOOR-01", product_id: 5764460660, stock: 100 },
];

(async () => {
  // 先取真实 product_id
  const info = await ozon("/v3/product/info/list", { offer_id: MOVES.map((m) => m.offer_id) });
  const pidByOffer = {};
  for (const it of info.items || []) pidByOffer[it.offer_id] = it.product_id || it.id;
  console.log("product_ids:", JSON.stringify(pidByOffer));

  const stocks = [];
  for (const m of MOVES) {
    const pid = pidByOffer[m.offer_id];
    if (!pid) { console.error("no product_id for", m.offer_id); continue; }
    stocks.push({ offer_id: m.offer_id, product_id: pid, stock: 0, warehouse_id: SMALL });
    stocks.push({ offer_id: m.offer_id, product_id: pid, stock: m.stock, warehouse_id: XS });
  }
  const r = await ozon("/v2/products/stocks", { stocks });
  for (const it of r.result || []) {
    console.log(it.offer_id, it.warehouse_id, "updated:", it.updated, it.errors?.length ? JSON.stringify(it.errors).slice(0, 200) : "OK");
  }
})().catch((e) => { console.error("FAILED:", e.message.slice(0, 400)); process.exit(1); });
