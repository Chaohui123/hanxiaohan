import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

// Create test order with delivered status
db.prepare("INSERT OR REPLACE INTO local_orders (id, posting_number, order_id, status, created_at, raw_json) VALUES (?,?,?,?,datetime('now'),?)")
  .run("order-test-auto", "OZON-AUTO-001", 99901, "delivered", "{}");

// Create test purchase
db.prepare(`INSERT OR REPLACE INTO purchase_1688
  (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url, sku_list_json, total_amount_cny, payment_status, pay_channel, logistics_status, freight_address, risk_check_json, created_at, updated_at)
  VALUES (?, 'store_1', ?, ?, ?, ?, ?, 'paid', 'manual_pay', 'shipped', ?, ?, datetime('now'), datetime('now'))`)
  .run("purchase-auto-test", "OZON-AUTO-001", 99901, "https://detail.1688.com/test", "[]", 199,
    "广东省东莞市...韩小寒 18928225650", "{}");

// Before
let before = db.prepare("SELECT id, payment_status FROM purchase_1688 WHERE id = ?").get("purchase-auto-test");
console.log("Before:", JSON.stringify(before));

// Simulate auto-complete logic (same as pollPurchaseStatus)
const purchases = db.prepare(
  "SELECT id, ozon_posting_number FROM purchase_1688 WHERE payment_status != 'completed' AND ozon_posting_number IS NOT NULL AND ozon_posting_number != '' LIMIT 100"
).all();

let auto = 0;
for (const p of purchases) {
  const o = db.prepare("SELECT status FROM local_orders WHERE posting_number = ? LIMIT 1").get(p.ozon_posting_number);
  if (o && o.status === "delivered") {
    db.prepare("UPDATE purchase_1688 SET payment_status = 'completed', logistics_status = 'delivered', updated_at = datetime('now') WHERE id = ?").run(p.id);
    auto++;
    console.log("  Auto-completed:", p.id, "→ Ozon status:", o.status);
  }
}

// After
let after = db.prepare("SELECT id, payment_status, logistics_status FROM purchase_1688 WHERE id = ?").get("purchase-auto-test");
console.log("After:", JSON.stringify(after));
console.log("Auto-completed count:", auto);
db.close();
