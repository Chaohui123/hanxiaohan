import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
const rows = db.prepare("SELECT id,name,leaf FROM ozon_categories LIMIT 5").all();
console.log('First 5 rows:');
rows.forEach(r => console.log(`${r.id}: ${r.name} (leaf=${r.leaf})`));

// Check how many have null names
const nullCount = db.prepare("SELECT COUNT(*) as c FROM ozon_categories WHERE name IS NULL").get();
console.log('Null names:', nullCount.c);
db.close();
