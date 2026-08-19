// 给全部在售商品生成 OZN 条形码（8/24 合同新规：卡片无码 Ozon 可拒付赔偿）
const { ozon } = require("./ozon-api.cjs");

(async () => {
  const list = await ozon("/v3/product/list", { filter: { visibility: "VISIBLE" }, limit: 100 });
  const pids = (list.result?.items || []).map((i) => i.product_id);
  console.log("visible products:", pids.length);

  const r = await ozon("/v1/barcode/generate", { product_ids: pids });
  console.log("generate:", JSON.stringify(r).slice(0, 600));

  await new Promise((s) => setTimeout(s, 8000));
  const attrs = await ozon("/v4/product/info/attributes", { filter: { product_id: pids.map(String), visibility: "ALL" }, limit: 100 });
  let ok = 0;
  for (const it of attrs.result || []) {
    const bc = it.barcode || (it.barcodes || [])[0] || "";
    if (bc) ok++;
    console.log(String(it.offer_id).padEnd(20), bc || "⚠️ 仍无码");
  }
  console.log(`\n有码: ${ok}/${(attrs.result || []).length}`);
})().catch((e) => { console.error("FAILED:", e.message.slice(0, 400)); process.exit(1); });
