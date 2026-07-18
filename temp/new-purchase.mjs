import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

db.prepare(`INSERT OR REPLACE INTO purchase_1688
  (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url,
   offer_id, sku_list_json, total_amount_cny, payment_status,
   pay_channel, logistics_status, freight_address, risk_check_json,
   created_at, updated_at)
  VALUES (?, 'store_1', ?, ?, ?, ?, ?, ?, 'pending_payment',
   'manual_pay', 'idle', ?, ?, datetime('now'), datetime('now'))`).run(
  'purchase-flow-001',
  'OZON-REAL-89001', 89001,
  'https://detail.1688.com/offer/722221688888.html',
  'test-offer-001',
  JSON.stringify([{sku: 1001, quantity: 3, unitPriceCny: 85.00}, {sku: 1002, quantity: 1, unitPriceCny: 120.00}]),
  375.00,
  '广东省东莞市常平镇土塘港建路45号7号楼放兔喜240247室 韩小寒 18928225650',
  JSON.stringify({manualPayMode: true, needsLogin: true})
);

const row = db.prepare('SELECT id, payment_status, total_amount_cny FROM purchase_1688 WHERE id = ?').get('purchase-flow-001');
console.log('Created:', JSON.stringify(row));
db.close();
