import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
// Find ALL leaf categories (any subcategory of anything)
const rows = db.prepare("SELECT id,name,parent_id,level FROM ozon_categories WHERE leaf=1 ORDER BY level ASC LIMIT 30").all();
rows.forEach(r => {
  // Find parent name
  const p = db.prepare("SELECT name FROM ozon_categories WHERE id=?").get(r.parent_id);
  console.log(`${r.id}: ${r.name} (under: ${p?.name || 'root'}, lvl=${r.level})`);
});
db.close();
