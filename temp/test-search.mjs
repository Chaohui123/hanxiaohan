import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
console.log('Total:', db.prepare('SELECT COUNT(*) as c FROM ozon_categories').get().c);
const rows = db.prepare("SELECT id,name,leaf FROM ozon_categories WHERE name LIKE '%наушник%'").all();
console.log('Search:', rows.length);
rows.slice(0,5).forEach(r => console.log(r.id, r.name, r.leaf));
db.close();
