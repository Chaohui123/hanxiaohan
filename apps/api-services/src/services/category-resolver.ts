// ============================================================
// Ozon Category Resolver — SQLite-backed category tree
// Returns leaf categories matched to keywords
// Refresh via POST /api/categories/refresh
// ============================================================

import { logger } from "@onzo/logger";

export interface CategoryResult {
  id: number;
  name: string;
  parentId: number;
  level: number;
  path: string[];
  typeId?: number;
}

let _db: {
  all: <T>(sql: string, params?: unknown[]) => T[];
  exec: (sql: string) => void;
} | null = null;

async function getDb() {
  if (_db) return _db;
  try {
    const Database = (await import("better-sqlite3")).default;
    const sqlite = new Database("./data/onzo.db");
    _db = {
      all: <T>(sql: string, params?: unknown[]) => {
        const stmt = sqlite.prepare(sql);
        return (params ? stmt.all(...params) : stmt.all()) as T[];
      },
      exec: (sql) => sqlite.exec(sql),
    };
    return _db;
  } catch { return null; }
}

export async function searchCategories(keyword: string): Promise<CategoryResult[]> {
  const db = await getDb();
  if (!db) {
    logger.warn("Category DB unavailable");
    return [];
  }

  const rows = db.all<{ id: number; name: string; parent_id: number; level: number }>(
    // Search non-leaf categories (have children = can host products). SQLite LIKE is case-insensitive.
    "SELECT id, name, parent_id, level FROM ozon_categories WHERE leaf = 0 AND name LIKE ? ORDER BY level ASC LIMIT 20",
    [`%${keyword}%`],
  );

  return rows.map((r) => ({
    id: r.id, name: r.name, parentId: r.parent_id, level: r.level, path: [],
  }));
}

export async function resolveCategory(keyword: string): Promise<CategoryResult | null> {
  const results = await searchCategories(keyword);
  if (results.length === 0) return null;
  const best = results.sort((a, b) => a.level - b.level)[0]!;

  // Find a leaf child to use as type_id
  const db = await getDb();
  if (db) {
    const children = db.all<{ id: number }>(
      "SELECT id FROM ozon_categories WHERE parent_id = ? AND leaf = 1 LIMIT 1", [best.id],
    );
    if (children[0]) best.typeId = children[0].id;
  }

  logger.info({ keyword, catId: best.id, typeId: best.typeId, catName: best.name }, "Category resolved");
  return best;
}

export async function refreshCategoryTree(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const key = (process.env.OZON_API_KEYS || "").split(",")[0] || "";
  const clientId = process.env.OZON_CLIENT_IDS || "";

  const resp = await fetch("https://api-seller.ozon.ru/v1/description-category/tree", {
    method: "POST",
    headers: { "Client-Id": clientId, "Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ language: "RU" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Ozon API ${resp.status}`);

  const data = await resp.json() as { result?: Array<{ description_category_id: number; category_name: string; children?: unknown[] }> };
  const tree = data.result || [];

  db.exec("DROP TABLE IF EXISTS ozon_categories");
  db.exec(`CREATE TABLE ozon_categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, level INTEGER, leaf INTEGER)`);

  // Use raw SQLite for batch insert (faster)
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database("./data/onzo.db");
  const insert = sqlite.prepare("INSERT OR REPLACE INTO ozon_categories(id,name,parent_id,level,leaf) VALUES(?,?,?,?,?)");

  function walk(nodes: Array<Record<string, unknown>>, parent: number, level: number) {
    for (const n of nodes) {
      const children = n.children as Array<Record<string, unknown>> | undefined;
      const leaf = children && (children as Array<unknown>).length > 0 ? 0 : 1;
      insert.run(n.description_category_id as number, n.category_name as string, parent, level, leaf);
      if (!leaf && children) walk(children, n.description_category_id as number, level + 1);
    }
  }

  walk(tree as Array<Record<string, unknown>>, 0, 0);
  sqlite.close();
  _db = null; // Reset cached DB

  const count = tree.length;
  logger.info({ count }, "Category tree refreshed");
  return count;
}
