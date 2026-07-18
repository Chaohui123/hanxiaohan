// Quick fix: rewrite the export route JS to use only the 'xlsx' library (already installed)
// but work with the existing sheet cells, not recreate anything

const fs = require("fs");
const path = require("path");

const file = "d:/Onzo/apps/api-services/src/routes/logistics.route.ts";
let content = fs.readFileSync(file, "utf-8");

// Find the export handler block
const startMarker = "router.post(\"/logistics/export-kuajingbus\"";
const endMarker = "  });\n\n  return router;";

// Build replacement code
const replacement = `router.post("/logistics/export-kuajingbus", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" } });

      const { ids } = (req.body || {}) as { ids?: string[] };
      if (!ids || ids.length === 0) {
        return res.status(400).json({ success: false, error: { code: "MISSING", message: "ids required" } });
      }

      const placeholders = ids.map(() => "?").join(",");
      const purchases = await db.all<Record<string, string>>(
        \`SELECT id, ozon_posting_number, logistics_tracking, sku_list_json
         FROM purchase_1688 WHERE id IN (\${placeholders}) ORDER BY created_at DESC\`,
        ids
      );
      if (purchases.length === 0) {
        return res.json({ success: true, data: { count: 0 } });
      }

      // Load original template
      const XLSX = await import("xlsx");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const tplPath = join(process.cwd(), "assets", "kuajingbus-template.xlsx");
      const wb = XLSX.read(readFileSync(tplPath), { type: "buffer", cellStyles: true });

      const ws = wb.Sheets[wb.SheetNames[0]!];
      if (!ws) throw new Error("Sheet not found");

      // Find marker row
      let startRow = 7;
      const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
      for (let r = 0; r <= range.e.r; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        if (cell && cell.v && typeof cell.v === "string" && cell.v.includes("真实订单")) {
          startRow = r + 1;
          break;
        }
      }

      // Get SKU weights
      const skuRows = await db.all<{ ozon_posting_number: string; weight_kg: number }>(
        \`SELECT DISTINCT ozon_offer_id, weight_kg FROM sku_1688_mapping\`
      ).catch(() => []);
      const wm = new Map<string, number>();
      for (const s of skuRows) wm.set(s.ozon_posting_number, s.weight_kg || 0.3);

      // Append data rows
      let rowIdx = startRow;
      const cols = "ABCDEFGHIJKLM";
      for (const p of purchases) {
        const skus = JSON.parse(p.sku_list_json || "[]") as Array<{ sku: number; quantity: number; unitPriceCny: number }>;
        if (skus.length === 0) continue;

        const qty = skus.reduce((s, sk) => s + sk.quantity, 0);
        const w = wm.get(p.ozon_posting_number) || "";
        const vals = [
          "", "1052", "10", p.ozon_posting_number, p.logistics_tracking || "",
          "", "", String(qty), "1688", "", w ? String(w) : "", "1688", p.id,
        ];

        for (let ci = 0; ci < vals.length; ci++) {
          ws[XLSX.utils.encode_cell({ r: rowIdx, c: ci })] = { t: "s", v: vals[ci] };
        }
        rowIdx++;
      }

      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rowIdx - 1, c: 12 } });

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
      const filename = \`跨境巴士_\${new Date().toISOString().slice(0, 10)}.xlsx\`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", \`attachment; filename=\${encodeURIComponent(filename)}\`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "EXPORT_ERROR", message: (err as Error).message } });
    }
  });

  return router;`;

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker, startIdx);
content = content.slice(0, startIdx) + replacement;

fs.writeFileSync(file, content);
console.log("Fixed");
