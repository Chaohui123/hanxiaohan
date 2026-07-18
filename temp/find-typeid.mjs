import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
// Find type_id for Наушники и гарнитуры
const children = db.prepare("SELECT id,name,leaf FROM ozon_categories WHERE parent_id=17028929 LIMIT 10").all();
console.log('Children of Наушники и гарнитуры (17028929):', children.length);
children.forEach(r => console.log(`  ${r.id}: ${r.name} (leaf=${r.leaf})`));
db.close();
