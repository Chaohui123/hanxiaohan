import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
const r = db.prepare("SELECT id,name FROM ozon_categories WHERE name LIKE '%Наушники%'").all();
console.log('Count:', r.length);
r.forEach(row => console.log(row.id, row.name));
db.close();
