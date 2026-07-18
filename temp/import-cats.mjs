import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS ozon_categories (
  id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER,
  level INTEGER, leaf INTEGER, updated_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cat_parent ON ozon_categories(parent_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cat_name ON ozon_categories(name)`);

const tree = JSON.parse(readFileSync('/tmp/ozon-tree.json', 'utf8')).result || [];

const insert = db.prepare(
  "INSERT OR REPLACE INTO ozon_categories(id, name, parent_id, level, leaf, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
);

function walk(nodes, parent, level) {
  for (const n of nodes) {
    const leaf = n.children && n.children.length > 0 ? 0 : 1;
    insert.run(n.description_category_id, n.category_name, parent, level, leaf);
    if (!leaf && n.children) walk(n.children, n.description_category_id, level + 1);
  }
}

walk(tree, 0, 0);

console.log('Total:', db.prepare('SELECT COUNT(*) as c FROM ozon_categories').get().c);
console.log('Leaves:', db.prepare('SELECT COUNT(*) as c FROM ozon_categories WHERE leaf=1').get().c);
db.close();
