import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

// Create test purchases ready for export (paid + shipping)
const orders = [
  {
    id: "export-test-001",
    posting: "OZON-EXPORT-001",
    tracking: "CDEK-9988776655",
    skus: [{ sku: 1001, quantity: 2, unitPriceCny: 85 }],
    amount: 170,
  },
  {
    id: "export-test-002",
    posting: "OZON-EXPORT-002",
    tracking: "UNI-1122334455",
    skus: [{ sku: 2001, quantity: 1, unitPriceCny: 120 }, { sku: 2002, quantity: 3, unitPriceCny: 45 }],
    amount: 255,
  },
];

for (const o of orders) {
  db.prepare(`INSERT OR REPLACE INTO purchase_1688
    (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url, sku_list_json,
     total_amount_cny, payment_status, pay_channel, logistics_status, logistics_tracking,
     freight_address, risk_check_json, created_at, updated_at)
    VALUES (?, 'store_1', ?, ?, ?, ?, ?, 'paid', 'manual_pay', 'shipped', ?,
     '广东省东莞市常平镇...韩小寒 18928225650', '{}', datetime('now'), datetime('now'))`)
    .run(o.id, o.posting, 99001 + orders.indexOf(o), "https://detail.1688.com/test",
      JSON.stringify(o.skus), o.amount, o.tracking);

  // Also create SKU mapping weight
  db.prepare(`INSERT OR REPLACE INTO sku_1688_mapping
    (id, store_id, ozon_offer_id, ozon_sku, source_1688_url, purchase_price_cny, weight_kg, freight_address, created_at, updated_at)
    VALUES (?, 'store_1', ?, ?, ?, ?, ?, '东莞', datetime('now'), datetime('now'))`)
    .run("sku-" + o.posting, "offer-" + o.posting, o.skus[0].sku, "https://detail.1688.com/test", o.skus[0].unitPriceCny, 0.8);
}

console.log("Created", orders.length, "test purchases for export");
db.close();
