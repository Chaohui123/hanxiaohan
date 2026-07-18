import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');

// Search broadly
const kw = '%науш%';
const rows = db.prepare("SELECT id,name,leaf,level,parent_id FROM ozon_categories WHERE name LIKE ? ORDER BY level ASC LIMIT 20").all(kw);
console.log('Results:', rows.length);
for (const r of rows) {
  const p = db.prepare("SELECT name FROM ozon_categories WHERE id=?").get(r.parent_id);
  console.log(`${r.id}: ${r.name} (leaf=${r.leaf}, lvl=${r.level}, parent=${p?.name || 'root'})`);
}

// Also search for гарнитур (headset)
const h = db.prepare("SELECT id,name,leaf,level FROM ozon_categories WHERE name LIKE '%гарнитур%' ORDER BY level ASC").all();
console.log('\nHeadsets:', h.length);
h.forEach(r => console.log(`  ${r.id}: ${r.name} (leaf=${r.leaf}, lvl=${r.level})`));

db.close();
