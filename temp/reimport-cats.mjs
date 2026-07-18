import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

db.exec("DROP TABLE IF EXISTS ozon_categories");
db.exec("CREATE TABLE ozon_categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, level INTEGER, leaf INTEGER)");

const raw = readFileSync('/tmp/ozon-tree.json', 'utf8');
const data = JSON.parse(raw);
const tree = data.result || [];

const insert = db.prepare("INSERT OR REPLACE INTO ozon_categories(id,name,parent_id,level,leaf) VALUES(?,?,?,?,?)");

// Category nodes: {description_category_id, category_name, children: [type_nodes...]}
// Type nodes (leaf): {type_id, type_name, children: []}
function walk(nodes, parent, level) {
  for (const n of nodes) {
    // Check if this is a category node (has description_category_id)
    if (n.description_category_id) {
      const children = n.children || [];
      const leaf = children.length === 0 ? 1 : 0;
      insert.run(n.description_category_id, n.category_name || n.type_name, parent, level, leaf);
      // Walk children
      for (const child of children) {
        if (child.description_category_id) {
          walk([child], n.description_category_id, level + 1);
        } else {
          // Type node (leaf under this category)
          if (child.type_id) {
            insert.run(child.type_id, child.type_name, n.description_category_id, level + 1, 1);
          }
        }
      }
    }
  }
}

walk(tree, 0, 0);

console.log('Total:', db.prepare("SELECT COUNT(*) as c FROM ozon_categories").get().c);
console.log('With names:', db.prepare("SELECT COUNT(*) as c FROM ozon_categories WHERE name IS NOT NULL").get().c);
console.log('Null names:', db.prepare("SELECT COUNT(*) as c FROM ozon_categories WHERE name IS NULL").get().c);

// Sample categories
const sample = db.prepare("SELECT id,name,leaf FROM ozon_categories WHERE name IS NOT NULL AND leaf=1 LIMIT 5").all();
console.log('Leaf samples:');
sample.forEach(r => console.log(`  ${r.id}: ${r.name}`));

// Audio/headphone categories
const audio = db.prepare("SELECT id,name,leaf FROM ozon_categories WHERE name LIKE '%аудио%' OR name LIKE '%науш%' OR name LIKE '%головны%' LIMIT 10").all();
console.log('Audio search:', audio.length);
audio.forEach(r => console.log(`  ${r.id}: ${r.name} (leaf=${r.leaf})`));

db.close();
