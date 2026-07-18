import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
// Search for any audio-related category
const rows = db.prepare("SELECT id,name,leaf,level FROM ozon_categories WHERE name LIKE '%аудио%' OR name LIKE '%науш%' OR name LIKE '%голов%' OR name LIKE '%звук%' LIMIT 20").all();
console.log('Audio-related:', rows.length);
rows.forEach(r => console.log(r.id, r.name, 'leaf='+r.leaf, 'lvl='+r.level));

// Show all leaf electronics subcategories
const elec = db.prepare("SELECT id,name,leaf FROM ozon_categories WHERE parent_id = (SELECT id FROM ozon_categories WHERE name='Электроника' LIMIT 1) LIMIT 10").all();
console.log('\nElectronics subs:', elec.length);
elec.forEach(r => console.log(r.id, r.name));
db.close();
